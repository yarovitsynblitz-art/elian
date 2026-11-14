import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChatSummary, Message, PublicUser } from '@elian/shared';
import { api } from '../lib/api';
import { useAppStore, useChatIndex } from '../store/app';
import { Avatar, Button, EmptyState, Modal, Spinner } from './ui';
import { Icon } from './icons';
import { formatTime } from './format';

export function SearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [data, setData] = useState<{ users: PublicUser[]; chats: ChatSummary[]; messages: Message[]; publicChats: ChatSummary[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => JSON.parse(localStorage.getItem('elian.recentSearches') ?? '[]'));
  const upsertChat = useChatIndex((state) => state.upsertChat);
  const toast = useAppStore((state) => state.toast);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) { setData(null); return; }
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const result = await api.get<{ users: PublicUser[]; chats: ChatSummary[]; messages: Message[]; publicChats: ChatSummary[] }>('/search', { q: trimmed });
        setData(result);
        const next = [trimmed, ...recent.filter((item) => item !== trimmed)].slice(0, 8);
        setRecent(next);
        localStorage.setItem('elian.recentSearches', JSON.stringify(next));
      } catch (error) {
        toast((error as Error).message, 'error');
      } finally {
        setLoading(false);
      }
    }, 320);
    return () => clearTimeout(timer);
  }, [query, open]);

  async function openUser(user: PublicUser) {
    try {
      const result = await api.post<{ chat: ChatSummary }>('/chats/private', { userId: user.id });
      upsertChat(result.chat);
      onClose();
      navigate(`/chat/${result.chat.id}`);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Поиск" wide>
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Люди, чаты, сообщения…"
        className="field mb-3"
      />
      {loading ? <div className="flex justify-center py-4"><Spinner /></div> : null}
      {!query && recent.length ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {recent.map((item) => (
            <button key={item} className="chip bg-surface-hover text-ink-muted" onClick={() => setQuery(item)}>{item}</button>
          ))}
        </div>
      ) : null}
      {data ? (
        <div className="space-y-4">
          {data.users.length ? (
            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">Люди</h4>
              {data.users.map((user) => (
                <button key={user.id} className="chat-row" onClick={() => void openUser(user)}>
                  <Avatar name={user.displayName} src={user.avatarUrl} size={36} seed={user.id} showOnline online={user.online} />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-medium">{user.displayName}</span>
                    <span className="block truncate text-xs text-ink-muted">@{user.username}</span>
                  </span>
                  <Icon name="chevron-right" size={16} className="text-ink-faint" />
                </button>
              ))}
            </section>
          ) : null}
          {data.chats.length ? (
            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">Чаты</h4>
              {data.chats.map((chat) => (
                <button key={chat.id} className="chat-row" onClick={() => { onClose(); navigate(`/chat/${chat.id}`); }}>
                  <Avatar name={chat.title} src={chat.avatarUrl} size={36} seed={chat.id} />
                  <span className="text-sm">{chat.title}</span>
                </button>
              ))}
            </section>
          ) : null}
          {data.publicChats?.length ? (
            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">Публичные чаты</h4>
              {data.publicChats.map((chat) => (
                <button key={chat.id} className="chat-row" onClick={() => { onClose(); navigate(`/chat/${chat.id}`); }}>
                  <Avatar name={chat.title} src={chat.avatarUrl} size={36} seed={chat.id} />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm">{chat.title}</span>
                    <span className="block text-xs text-ink-muted">{chat.memberCount} участников</span>
                  </span>
                  <Button size="sm" variant="soft" onClick={async (event) => {
                    event.stopPropagation();
                    try {
                      await api.post(`/chats/${chat.id}/join`);
                      toast('Вы вступили в чат', 'success');
                    } catch (error) {
                      toast((error as Error).message, 'error');
                    }
                  }}>Вступить</Button>
                </button>
              ))}
            </section>
          ) : null}
          {data.messages.length ? (
            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">Сообщения</h4>
              {data.messages.map((message) => (
                <button key={message.id} className="block w-full rounded-xl2 px-2 py-2 text-left hover:bg-surface-hover" onClick={() => { onClose(); navigate(`/chat/${message.chatId}`); }}>
                  <div className="text-xs font-semibold">{message.sender?.displayName ?? '—'} <span className="text-ink-faint">{formatTime(message.createdAt)}</span></div>
                  <div className="truncate text-xs text-ink-muted">{message.text}</div>
                </button>
              ))}
            </section>
          ) : null}
          {!data.users.length && !data.chats.length && !data.messages.length && !(data.publicChats ?? []).length ? (
            <EmptyState icon="search" title="Ничего не найдено" description="Попробуйте другой запрос или точный @username." />
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

export function useSearchModal() {
  const [open, setOpen] = useState(false);
  return { open, show: () => setOpen(true), hide: () => setOpen(false) };
}
