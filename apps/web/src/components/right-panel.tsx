import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChatSummary, PublicUser } from '@elian/shared';
import { api } from '../lib/api';
import { useAppStore } from '../store/app';
import { Avatar, Badge, Button, Modal } from './ui';
import { Icon } from './icons';
import { lastSeenLabel } from './format';
import { useChat } from '../hooks/useElian';

interface Member {
  user: PublicUser;
  role: 'owner' | 'admin' | 'member';
  mutedUntil: string | null;
  joinedAt: string;
}

export function RightPanel({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useAppStore((state) => state.toast);
  const chatQuery = useChat(chatId);
  const chat = chatQuery.data?.chat;
  const peer = chatQuery.data?.peer;
  const [tab, setTab] = useState<'profile' | 'members' | 'media'>('profile');
  const [members, setMembers] = useState<Member[]>([]);
  const [media, setMedia] = useState<Array<{ id: string; thumbUrl: string | null; url: string | null; kind: string }>>([]);
  const [confirmLeave, setConfirmLeave] = useState(false);

  async function loadMembers() {
    try {
      const result = await api.get<{ members: Member[] }>(`/chats/${chatId}/members`);
      setMembers(result.members);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  async function loadMedia() {
    try {
      const result = await api.get<{ messages: Array<{ attachments: Array<{ id: string; thumbUrl: string | null; url: string | null; kind: string }> }> }>(`/chats/${chatId}/media`);
      setMedia(result.messages.flatMap((message) => message.attachments));
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  async function action(path: string, body?: unknown, method: 'POST' | 'DELETE' = 'POST') {
    try {
      if (method === 'POST') await api.post(path, body);
      else await api.del(path);
      toast('Готово', 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  if (!chat) return null;

  return (
    <aside className="flex h-full w-full flex-col border-l border-line bg-surface">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <div className="flex gap-1">
          {(['profile', 'members', 'media'] as const).map((item) => (
            <button
              key={item}
              onClick={() => {
                setTab(item);
                if (item === 'members' && !members.length) void loadMembers();
                if (item === 'media' && !media.length) void loadMedia();
              }}
              className={`chip ${tab === item ? 'bg-brand text-white' : 'bg-surface-hover text-ink-muted'}`}
            >
              {item === 'profile' ? 'Профиль' : item === 'members' ? 'Участники' : 'Медиа'}
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Закрыть панель"><Icon name="close" size={18} /></button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'profile' ? (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-2 text-center">
              <Avatar name={peer?.displayName ?? chat.title} src={peer?.avatarUrl ?? chat.avatarUrl} size={80} seed={chat.id} />
              <div className="text-base font-semibold">{peer?.displayName ?? chat.title}</div>
              <div className="text-xs text-ink-muted">
                {chat.type === 'private' && peer ? lastSeenLabel(peer.lastSeenAt, peer.online) : `${chat.memberCount} участников`}
              </div>
              {peer?.username ? <Badge tone="muted">@{peer.username}</Badge> : null}
              {peer?.bio ? <p className="text-xs text-ink-muted">{peer.bio}</p> : null}
            </div>

            <div className="grid grid-cols-2 gap-2">
              {chat.type === 'private' && peer ? (
                <>
                  <Button variant="soft" icon="phone" onClick={() => navigate(`/call/audio/${peer.id}`)}>Звонок</Button>
                  <Button variant="soft" icon="video" onClick={() => navigate(`/call/video/${peer.id}`)}>Видео</Button>
                  <Button variant="soft" icon="user-plus" onClick={() => action(`/contacts/${peer.id}`)}>В контакты</Button>
                  <Button variant="soft" icon="ban" onClick={() => action(`/blocks/${peer.id}`)}>Заблокировать</Button>
                </>
              ) : (
                <>
                  <Button variant="soft" icon="users" onClick={() => setTab('members')}>Участники</Button>
                  <Button variant="soft" icon="image" onClick={() => setTab('media')}>Медиа</Button>
                </>
              )}
            </div>

            <div className="space-y-1">
              <PanelAction icon="volume-x" label={chat.muted ? 'Включить уведомления' : 'Отключить уведомления'} onClick={() => action(`/chats/${chatId}/mute`, { value: !chat.muted })} />
              <PanelAction icon="archive" label={chat.archived ? 'Вернуть из архива' : 'В архив'} onClick={() => action(`/chats/${chatId}/archive`, { value: !chat.archived })} />
              <PanelAction icon="trash" label="Пожаловаться" danger onClick={() => action('/reports', { targetChatId: chatId, reason: 'spam' })} />
              <PanelAction icon="logout" label={chat.role === 'owner' && chat.type !== 'private' ? 'Удалить чат' : 'Покинуть чат'} danger onClick={() => setConfirmLeave(true)} />
            </div>
          </div>
        ) : null}

        {tab === 'members' ? (
          <div className="space-y-1">
            {members.length === 0 ? <p className="text-xs text-ink-muted">Загрузка…</p> : null}
            {members.map((member) => (
              <div key={member.user.id} className="flex items-center gap-2 rounded-xl2 px-2 py-2 hover:bg-surface-hover">
                <Avatar name={member.user.displayName} src={member.user.avatarUrl} size={36} seed={member.user.id} showOnline online={member.user.online} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{member.user.displayName}</div>
                  <div className="truncate text-[11px] text-ink-muted">@{member.user.username}</div>
                </div>
                {member.role !== 'member' ? <Badge tone="muted">{member.role === 'owner' ? 'владелец' : 'админ'}</Badge> : null}
              </div>
            ))}
          </div>
        ) : null}

        {tab === 'media' ? (
          <div className="grid grid-cols-3 gap-1">
            {media.length === 0 ? <p className="col-span-3 text-xs text-ink-muted">Пока нет вложений</p> : null}
            {media.map((item) => (
              <a key={item.id} href={item.url ?? '#'} target="_blank" rel="noopener noreferrer" className="aspect-square overflow-hidden rounded-lg bg-surface-hover">
                {item.thumbUrl ? <img src={item.thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" /> : (
                  <span className="flex h-full items-center justify-center text-ink-faint"><Icon name="file" /></span>
                )}
              </a>
            ))}
          </div>
        ) : null}
      </div>

      <Modal
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title="Покинуть чат?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmLeave(false)}>Отмена</Button>
            <Button
              variant="danger"
              onClick={async () => {
                await action(`/chats/${chatId}`, undefined, 'DELETE');
                setConfirmLeave(false);
                navigate('/');
              }}
            >
              Выйти
            </Button>
          </div>
        }
      >
        <p className="text-sm text-ink-muted">Вы больше не будете получать сообщения из этого чата. История сохранится на сервере.</p>
      </Modal>
    </aside>
  );
}

function PanelAction({ icon, label, onClick, danger }: { icon: string; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl2 px-2.5 py-2 text-left text-sm hover:bg-surface-hover ${danger ? 'text-danger' : ''}`}
    >
      <Icon name={icon} size={17} />
      {label}
    </button>
  );
}

export type { ChatSummary };
