import { useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { flushOutbox, useMe, useOnlineStatus, usePresence } from './hooks/useElian';
import { useAppStore, useChatIndex } from './store/app';
import { connectSocket } from './lib/socket';
import { LoginPage, PendingPage, RegisterPage, ResetRequestPage, ResetStatusPage } from './pages/auth';
import { MainShell } from './pages/app';
import { Toasts, Spinner, BrandMark } from './components/ui';
import type { ChatSummary, Message } from '@elian/shared';
import { cacheMessages } from './lib/db';

function BootScreen() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4">
      <BrandMark />
      <Spinner />
    </div>
  );
}

/** Подключение realtime и синхронизация кэша запросов. */
function RealtimeBridge() {
  const user = useAppStore((state) => state.user);
  const queryClient = useQueryClient();
  const upsertChat = useChatIndex((state) => state.upsertChat);
  const removeChat = useChatIndex((state) => state.removeChat);
  const toast = useAppStore((state) => state.toast);
  const online = useAppStore((state) => state.online);

  useEffect(() => {
    if (!user) return;
    const socket = connectSocket();
    const onNewMessage = (payload: { message: Message; chat: ChatSummary | null }) => {
      const { message, chat } = payload;
      queryClient.setQueryData<Message[]>(['messages', message.chatId], (current = []) => {
        if (current.some((existing) => existing.id === message.id)) return current;
        return [...current, message];
      });
      void cacheMessages([message]);
      if (chat?.id) upsertChat(chat);
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
    };
    const onEdited = (payload: { message: Message }) => {
      queryClient.setQueryData<Message[]>(['messages', payload.message.chatId], (current = []) =>
        current.map((message) => (message.id === payload.message.id ? payload.message : message)),
      );
    };
    const onDeleted = (payload: { chatId: string; messageId: string }) => {
      queryClient.setQueryData<Message[]>(['messages', payload.chatId], (current = []) =>
        current.map((message) =>
          message.id === payload.messageId
            ? { ...message, deletedAt: new Date().toISOString(), text: '', attachments: [], reactions: [], poll: null }
            : message,
        ),
      );
    };
    const onReactions = (payload: { chatId: string; messageId: string; reactions: Message['reactions'] }) => {
      queryClient.setQueryData<Message[]>(['messages', payload.chatId], (current = []) =>
        current.map((message) => (message.id === payload.messageId ? { ...message, reactions: payload.reactions } : message)),
      );
    };
    const onChatUpdated = (payload: { chat: ChatSummary }) => upsertChat(payload.chat);
    const onChatRemoved = (payload: { chatId: string }) => {
      removeChat(payload.chatId);
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
    };
    const onReceipt = () => void queryClient.invalidateQueries({ queryKey: ['messages'] });
    const onSessionRevoked = () => {
      toast('Сессия завершена на другом устройстве', 'info');
      void queryClient.invalidateQueries();
    };
    const onError = (payload: { message: string }) => toast(payload.message, 'error');

    socket.on('message:new', onNewMessage);
    socket.on('message:edited', onEdited);
    socket.on('message:deleted', onDeleted);
    socket.on('reaction:changed', onReactions);
    socket.on('chat:updated', onChatUpdated);
    socket.on('chat:removed', onChatRemoved);
    socket.on('receipt', onReceipt);
    socket.on('auth:session_revoked', onSessionRevoked);
    socket.on('error', onError);
    if (!socket.connected) socket.connect();
    socket.emit('presence:ping');
    const presenceTimer = setInterval(() => socket.emit('presence:ping'), 60_000);
    return () => {
      clearInterval(presenceTimer);
      socket.off('message:new', onNewMessage);
      socket.off('message:edited', onEdited);
      socket.off('message:deleted', onDeleted);
      socket.off('reaction:changed', onReactions);
      socket.off('chat:updated', onChatUpdated);
      socket.off('chat:removed', onChatRemoved);
      socket.off('receipt', onReceipt);
      socket.off('auth:session_revoked', onSessionRevoked);
      socket.off('error', onError);
    };
  }, [user, queryClient, upsertChat, removeChat, toast]);

  useEffect(() => {
    if (online) {
      void flushOutbox();
    }
  }, [online]);

  useOnlineStatus();
  usePresence([]);
  return null;
}

function Protected({ children }: { children: React.ReactNode }) {
  const status = useAppStore((state) => state.status);
  if (status === 'loading') return <BootScreen />;
  if (status === 'anon') return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  const status = useAppStore((state) => state.status);
  const setInstallPrompt = useAppStore((state) => state.setInstallPrompt);
  useMe();

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(true);
      (window as unknown as { __elianInstall?: Event }).__elianInstall = event;
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [setInstallPrompt]);

  return (
    <>
      <RealtimeBridge />
      <Routes>
        <Route path="/login" element={status === 'authed' ? <Navigate to="/" replace /> : <LoginPage />} />
        <Route path="/register" element={status === 'authed' ? <Navigate to="/" replace /> : <RegisterPage />} />
        <Route path="/pending" element={<PendingPage />} />
        <Route path="/reset" element={<ResetRequestPage />} />
        <Route path="/reset/status" element={<ResetStatusPage />} />
        <Route path="/*" element={<Protected><MainShell /></Protected>} />
      </Routes>
      <Toasts />
    </>
  );
}

export { useNavigate };
