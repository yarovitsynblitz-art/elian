import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatSummary, PublicUser } from '@elian/shared';
import { api } from '../lib/api';
import { useAppStore, useChatIndex } from '../store/app';
import { Avatar, Button, Input, Modal, Textarea } from './ui';
import { Icon } from './icons';

type Mode = 'private' | 'group' | 'channel' | 'public';

export function NewChatModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useAppStore((state) => state.toast);
  const upsertChat = useChatIndex((state) => state.upsertChat);
  const [mode, setMode] = useState<Mode>('private');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PublicUser[]>([]);
  const [selected, setSelected] = useState<PublicUser[]>([]);
  const [publicChats, setPublicChats] = useState<ChatSummary[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [username, setUsername] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);

  async function search(value: string) {
    setQuery(value);
    if (value.trim().length < 2) { setResults([]); return; }
    try {
      if (mode === 'public') {
        const result = await api.get<{ chats: ChatSummary[] }>('/chats/search/public', { q: value });
        setPublicChats(result.chats);
      } else {
        const result = await api.get<{ users: PublicUser[] }>('/search/users', { q: value });
        setResults(result.users);
      }
    } catch {
      /* игнорируем */
    }
  }

  async function startPrivate(user: PublicUser) {
    setBusy(true);
    try {
      const result = await api.post<{ chat: ChatSummary }>('/chats/private', { userId: user.id });
      upsertChat(result.chat);
      onClose();
      navigate(`/chat/${result.chat.id}`);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function createChat() {
    setBusy(true);
    try {
      const result = await api.post<{ chat: ChatSummary }>('/chats', {
        type: mode === 'channel' ? 'channel' : 'group',
        title,
        description: description || null,
        username: isPublic && username ? username : null,
        isPublic,
        memberIds: selected.map((user) => user.id),
      });
      upsertChat(result.chat);
      await queryClient.invalidateQueries({ queryKey: ['chats'] });
      onClose();
      navigate(`/chat/${result.chat.id}`);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Новый чат" wide>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {([
          ['private', 'Личный чат'],
          ['group', 'Группа'],
          ['channel', 'Канал'],
          ['public', 'Публичные'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            onClick={() => { setMode(value); setQuery(''); setResults([]); setPublicChats([]); }}
            className={`chip ${mode === value ? 'bg-brand text-white' : 'bg-surface-hover text-ink-muted'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'private' || mode === 'public' ? (
        <div className="space-y-3">
          <Input
            autoFocus
            value={query}
            onChange={(event) => void search(event.target.value)}
            placeholder={mode === 'public' ? 'Название или @адрес' : 'Поиск по @username'}
          />
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {results.map((user) => (
              <button key={user.id} onClick={() => void startPrivate(user)} className="chat-row">
                <Avatar name={user.displayName} src={user.avatarUrl} size={40} seed={user.id} />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm font-medium">{user.displayName}</span>
                  <span className="block truncate text-xs text-ink-muted">@{user.username}</span>
                </span>
                <Icon name="chevron-right" size={16} className="text-ink-faint" />
              </button>
            ))}
            {publicChats.map((chat) => (
              <button
                key={chat.id}
                onClick={async () => {
                  try {
                    const result = await api.post<{ chat: ChatSummary }>(`/chats/${chat.id}/join`);
                    upsertChat(result.chat);
                    onClose();
                    navigate(`/chat/${chat.id}`);
                  } catch (error) {
                    toast((error as Error).message, 'error');
                  }
                }}
                className="chat-row"
              >
                <Avatar name={chat.title} src={chat.avatarUrl} size={40} seed={chat.id} />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm font-medium">{chat.title}</span>
                  <span className="block truncate text-xs text-ink-muted">{chat.memberCount} участников {chat.username ? `· @${chat.username}` : ''}</span>
                </span>
                <Button size="sm" variant="soft">Вступить</Button>
              </button>
            ))}
            {!results.length && !publicChats.length ? (
              <p className="px-2 py-4 text-center text-xs text-ink-faint">
                {query ? 'Ничего не найдено' : mode === 'public' ? 'Начните вводить название' : 'Введите минимум 2 символа @username'}
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Input label="Название" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={128} />
          <Textarea label="Описание" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1024} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />
            Публичный {mode === 'channel' ? 'канал' : 'чат'} (доступен по @адресу)
          </label>
          {isPublic ? <Input label="Публичный адрес" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="my_channel" /> : null}
          <div>
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-faint">Участники</span>
            <Input value={query} onChange={(event) => void search(event.target.value)} placeholder="Добавить по @username" />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {selected.map((user) => (
                <span key={user.id} className="chip bg-surface-hover text-ink">
                  {user.displayName}
                  <button onClick={() => setSelected((current) => current.filter((item) => item.id !== user.id))} aria-label="Убрать">
                    <Icon name="close" size={12} />
                  </button>
                </span>
              ))}
            </div>
            <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
              {results.map((user) => (
                <button
                  key={user.id}
                  className="chat-row"
                  onClick={() => setSelected((current) => (current.some((item) => item.id === user.id) ? current : [...current, user]))}
                >
                  <Avatar name={user.displayName} src={user.avatarUrl} size={32} seed={user.id} />
                  <span className="text-sm">{user.displayName} <span className="text-xs text-ink-muted">@{user.username}</span></span>
                  <Icon name="plus" size={14} className="ml-auto text-ink-faint" />
                </button>
              ))}
            </div>
          </div>
          <Button className="w-full" loading={busy} disabled={title.trim().length === 0} onClick={() => void createChat()}>
            Создать {mode === 'channel' ? 'канал' : 'группу'}
          </Button>
        </div>
      )}
    </Modal>
  );
}
