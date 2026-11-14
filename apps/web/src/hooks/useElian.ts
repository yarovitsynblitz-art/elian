import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Attachment, ChatSummary, Message, PublicUser, SelfUser, SessionInfo, Folder, Story, CallInfo,
} from '@elian/shared';
import { api, ApiError } from '../lib/api';
import { useAppStore, useChatIndex } from '../store/app';
import { cacheChats, cacheMessages, queueOutbox, readCachedChats, readCachedMessages, removeOutbox, pendingOutbox } from '../lib/db';
import { getSocket } from '../lib/socket';

export interface AppConfig {
  brand: { name: string; nameLatin: string; tagline: string; primary: string; secondary: string };
  version: string;
  limits: Record<string, number>;
  features: {
    registration: boolean;
    ownerApproval: boolean;
    push: boolean;
    calls: { oneToOne: boolean; group: boolean; turn: boolean };
    gifSearch: boolean;
    stories: boolean;
    bots: boolean;
    stickers: boolean;
    encryptionAtRest: boolean;
    e2e: boolean;
  };
  vapidPublicKey: string | null;
  iceServers: RTCIceServer[];
  domain: string;
}

export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<AppConfig>('/config'),
    staleTime: 5 * 60_000,
  });
}

const LAST_USER_KEY = 'elian.lastUser';

function readLastUser(): SelfUser | null {
  try {
    const raw = localStorage.getItem(LAST_USER_KEY);
    return raw ? (JSON.parse(raw) as SelfUser) : null;
  } catch {
    return null;
  }
}

export function useMe() {
  const setUser = useAppStore((state) => state.setUser);
  const status = useAppStore((state) => state.status);
  const setStatus = useAppStore((state) => state.setStatus);
  const query = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const result = await api.get<{ user: SelfUser }>('/auth/me');
        try {
          localStorage.setItem(LAST_USER_KEY, JSON.stringify(result.user));
        } catch {
          /* приватный режим */
        }
        return result.user;
      } catch (error) {
        // 401 — сессия действительно недействительна.
        if (error instanceof ApiError && error.status === 401) {
          try {
            localStorage.removeItem(LAST_USER_KEY);
          } catch {
            /* игнорируем */
          }
          return null;
        }
        // Нет сети / сервер недоступен: не выбрасываем пользователя на экран входа,
        // а работаем от последнего известного профиля (кэш чатов и сообщений — локальный).
        const cached = readLastUser();
        if (cached) return cached;
        throw error;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
  useEffect(() => {
    if (query.isLoading) return;
    if (query.data) {
      setUser(query.data);
    } else {
      setStatus('anon');
    }
  }, [query.data, query.isLoading, setUser, setStatus]);
  return { ...query, user: query.data ?? null, status };
}

export function useChats(archived = false) {
  const setChats = useChatIndex((state) => state.setChats);
  const query = useQuery({
    queryKey: ['chats', archived],
    queryFn: async () => {
      try {
        const result = await api.get<{ chats: ChatSummary[] }>('/chats', { archived: archived ? '1' : '0' });
        await cacheChats(result.chats);
        return result.chats;
      } catch (error) {
        const cached = await readCachedChats();
        if (cached.length) return cached.filter((chat) => Boolean(chat.archived) === archived);
        throw error;
      }
    },
    staleTime: 15_000,
  });
  useEffect(() => {
    if (query.data) setChats(query.data);
  }, [query.data, setChats]);
  return query;
}

export function useChat(chatId: string | null) {
  return useQuery({
    queryKey: ['chat', chatId],
    queryFn: () => api.get<{ chat: ChatSummary; peer?: PublicUser }>(`/chats/${chatId}`),
    enabled: Boolean(chatId),
    staleTime: 10_000,
  });
}

export function useFolders() {
  return useQuery({ queryKey: ['folders'], queryFn: () => api.get<{ folders: Folder[] }>('/folders').then((r) => r.folders) });
}

export function useChatMessages(chatId: string | null) {
  const queryClient = useQueryClient();
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const key = ['messages', chatId];

  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      if (!chatId) return [] as Message[];
      try {
        const result = await api.get<{ messages: Message[]; hasMore: boolean }>(`/chats/${chatId}/messages`, { limit: 50 });
        setHasMore(result.hasMore);
        await cacheMessages(result.messages);
        return result.messages;
      } catch (error) {
        const cached = await readCachedMessages(chatId);
        if (cached.length) return cached;
        throw error;
      }
    },
    enabled: Boolean(chatId),
    staleTime: 5_000,
  });

  const loadOlder = useCallback(async () => {
    if (!chatId || loadingOlder || !hasMore) return;
    const current = queryClient.getQueryData<Message[]>(key) ?? [];
    const oldest = current[0]?.seq;
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const result = await api.get<{ messages: Message[]; hasMore: boolean }>(`/chats/${chatId}/messages`, { beforeSeq: oldest, limit: 50 });
      setHasMore(result.hasMore);
      if (result.messages.length) {
        queryClient.setQueryData<Message[]>(key, [...result.messages, ...current]);
        await cacheMessages(result.messages);
      }
    } finally {
      setLoadingOlder(false);
    }
  }, [chatId, hasMore, loadingOlder, queryClient, key]);

  return { ...query, messages: query.data ?? [], loadOlder, hasMore, loadingOlder };
}

export function useSendMessage(chatId: string | null) {
  const queryClient = useQueryClient();
  const toast = useAppStore((state) => state.toast);
  return useMutation({
    mutationFn: async (input: { text: string; replyToId?: string | null; attachments?: Attachment[]; silent?: boolean }) => {
      if (!chatId) throw new Error('no chat');
      const clientMessageId = crypto.randomUUID();
      const payload = {
        text: input.text,
        replyToId: input.replyToId ?? null,
        silent: input.silent,
        clientMessageId,
        attachments: (input.attachments ?? []).map((attachment) => ({
          kind: attachment.kind,
          mediaId: attachment.mediaId,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          size: attachment.size,
          width: attachment.width,
          height: attachment.height,
          duration: attachment.duration,
          waveform: attachment.waveform,
          spoiler: attachment.spoiler,
        })),
      };
      try {
        const result = await api.post<{ message: Message; chat: ChatSummary }>(`/chats/${chatId}/messages`, payload);
        return result.message;
      } catch (error) {
        // Offline-outbox: сохраняем для повторной отправки.
        if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) {
          await queueOutbox({ id: clientMessageId, chatId, text: input.text, clientMessageId, createdAt: Date.now(), replyToId: input.replyToId ?? null });
          toast('Нет сети — сообщение в очереди', 'info');
          return null;
        }
        throw error;
      }
    },
    onSuccess: (message) => {
      if (!message) return;
      queryClient.setQueryData<Message[]>(['messages', chatId], (current = []) => {
        if (current.some((existing) => existing.id === message.id)) return current;
        return [...current, message];
      });
    },
    onError: (error: unknown) => {
      toast(error instanceof Error ? error.message : 'Не удалось отправить', 'error');
    },
  });
}

export async function flushOutbox(): Promise<void> {
  const items = await pendingOutbox();
  for (const item of items) {
    try {
      await api.post(`/chats/${item.chatId}/messages`, {
        text: item.text,
        clientMessageId: item.clientMessageId,
        replyToId: item.replyToId ?? null,
      });
      await removeOutbox(item.id);
    } catch {
      break;
    }
  }
}

export function useChatActions(chatId: string | null) {
  const queryClient = useQueryClient();
  const toast = useAppStore((state) => state.toast);
  const patchChat = useChatIndex((state) => state.patchChat);

  const invalidateChat = () => {
    void queryClient.invalidateQueries({ queryKey: ['chats'] });
    if (chatId) void queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
  };

  const toggleReaction = useMutation({
    mutationFn: (input: { messageId: string; emoji: string; active: boolean }) =>
      api.post<{ reactions: Message['reactions'] }>(`/messages/${input.messageId}/reactions`, { emoji: input.emoji, active: input.active }),
    onSuccess: (result, input) => {
      queryClient.setQueryData<Message[]>(['messages', chatId], (current = []) =>
        current.map((message) => (message.id === input.messageId ? { ...message, reactions: result.reactions } : message)),
      );
    },
  });

  const editMessage = useMutation({
    mutationFn: (input: { messageId: string; text: string }) => api.patch<{ message: Message }>(`/messages/${input.messageId}`, { text: input.text }),
    onSuccess: (result) => {
      queryClient.setQueryData<Message[]>(['messages', chatId], (current = []) =>
        current.map((message) => (message.id === result.message.id ? result.message : message)),
      );
    },
    onError: (error: unknown) => toast(error instanceof Error ? error.message : 'Ошибка', 'error'),
  });

  const deleteMessage = useMutation({
    mutationFn: (input: { messageId: string; forEveryone: boolean }) =>
      api.del(`/messages/${input.messageId}?forEveryone=${input.forEveryone ? '1' : '0'}`),
    onSuccess: (_result, input) => {
      queryClient.setQueryData<Message[]>(['messages', chatId], (current = []) =>
        current.map((message) => (message.id === input.messageId
          ? { ...message, deletedAt: new Date().toISOString(), text: '', attachments: [], poll: null, reactions: [] }
          : message)),
      );
    },
  });

  const pinMessage = useMutation({
    mutationFn: (input: { messageId: string; pinned: boolean }) => api.post(`/messages/${input.messageId}/pin`, { pinned: input.pinned }),
    onSuccess: invalidateChat,
  });

  const markRead = useMutation({
    mutationFn: (upToSeq: number) => api.post(`/chats/${chatId}/read`, { upToSeq }),
    onSuccess: () => {
      patchChat(chatId ?? '', { unreadCount: 0 });
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
    },
  });

  const forward = useMutation({
    mutationFn: (input: { messageIds: string[]; toChatId: string }) =>
      api.post<{ chat: ChatSummary }>('/messages/forward', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
      toast('Переслано', 'success');
    },
    onError: (error: unknown) => toast(error instanceof Error ? error.message : 'Ошибка', 'error'),
  });

  const votePoll = useMutation({
    mutationFn: (input: { pollId: string; optionIds: string[] }) => api.post<{ poll: unknown }>(`/polls/${input.pollId}/vote`, { optionIds: input.optionIds }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['messages', chatId] }),
  });

  return { toggleReaction, editMessage, deleteMessage, pinMessage, markRead, forward, votePoll, invalidateChat };
}

export function useTyping(chatId: string | null) {
  const socket = getSocket();
  const lastSent = useRef(0);
  return useCallback(
    (kind: 'typing' | 'voice' | 'upload' | 'stop' = 'typing') => {
      if (!chatId) return;
      const now = Date.now();
      if (kind === 'typing' && now - lastSent.current < 2500) return;
      lastSent.current = now;
      socket.emit('typing', { chatId, kind });
    },
    [chatId, socket],
  );
}

export function useTypingIndicator(chatId: string | null) {
  const [typing, setTyping] = useState<Map<string, { kind: string; at: number }>>(new Map());
  useEffect(() => {
    const socket = getSocket();
    const handler = (payload: { chatId: string; userId: string; kind: string }) => {
      if (payload.chatId !== chatId) return;
      setTyping((current) => {
        const next = new Map(current);
        if (payload.kind === 'stop') next.delete(payload.userId);
        else next.set(payload.userId, { kind: payload.kind, at: Date.now() });
        return next;
      });
    };
    socket.on('typing', handler);
    const interval = setInterval(() => {
      setTyping((current) => {
        const next = new Map(current);
        let changed = false;
        for (const [userId, value] of next) {
          if (Date.now() - value.at > 4000) { next.delete(userId); changed = true; }
        }
        return changed ? next : current;
      });
    }, 1500);
    return () => {
      socket.off('typing', handler);
      clearInterval(interval);
    };
  }, [chatId]);
  return typing;
}

export function useSessions() {
  return useQuery({ queryKey: ['sessions'], queryFn: () => api.get<{ sessions: SessionInfo[] }>('/me/sessions').then((r) => r.sessions) });
}

export function useContacts() {
  return useQuery({ queryKey: ['contacts'], queryFn: () => api.get<{ contacts: PublicUser[] }>('/contacts').then((r) => r.contacts) });
}

export function useBlocked() {
  return useQuery({ queryKey: ['blocks'], queryFn: () => api.get<{ blocked: PublicUser[] }>('/blocks').then((r) => r.blocked) });
}

export function useStories() {
  return useQuery({ queryKey: ['stories'], queryFn: () => api.get<{ groups: Array<{ user: PublicUser; stories: Story[]; allSeen: boolean }> }>('/stories').then((r) => r.groups), staleTime: 30_000 });
}

export function useCalls() {
  return useQuery({ queryKey: ['calls'], queryFn: () => api.get<{ calls: CallInfo[] }>('/calls/history').then((r) => r.calls), staleTime: 20_000 });
}

export function useGlobalSearch(query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ['search', trimmed],
    queryFn: () => api.get<{ users: PublicUser[]; chats: ChatSummary[]; messages: Message[]; publicChats?: ChatSummary[] }>('/search', { q: trimmed }),
    enabled: trimmed.length >= 1,
    staleTime: 10_000,
  });
}

export function useChatSearch(chatId: string | null, query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ['chat-search', chatId, trimmed],
    queryFn: () => api.get<{ messages: Message[] }>(`/chats/${chatId}/search`, { q: trimmed }),
    enabled: Boolean(chatId) && trimmed.length >= 1,
    staleTime: 5_000,
  });
}

export function useOnlineStatus() {
  const setOnline = useAppStore((state) => state.setOnline);
  useEffect(() => {
    const onOnline = () => { setOnline(true); void flushOutbox(); };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [setOnline]);
}

export function usePresence(userIds: string[]) {
  const [presence, setPresence] = useState<Record<string, { online: boolean; lastSeenAt: string | null }>>({});
  const ids = useMemo(() => new Set(userIds), [userIds.join(',')]);
  useEffect(() => {
    const socket = getSocket();
    const handler = (payload: { userId: string; online: boolean; lastSeenAt: string | null }) => {
      if (!ids.has(payload.userId)) return;
      setPresence((current) => ({ ...current, [payload.userId]: { online: payload.online, lastSeenAt: payload.lastSeenAt } }));
    };
    socket.on('presence:changed', handler);
    return () => { socket.off('presence:changed', handler); };
  }, [ids]);
  return presence;
}
