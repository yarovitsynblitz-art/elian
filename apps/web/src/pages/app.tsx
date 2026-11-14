import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { PublicUser } from '@elian/shared';
import { api } from '../lib/api';
import { useAppStore } from '../store/app';
import { ChatList } from '../components/chat-list';
import { ChatView } from '../components/chat-view';
import { RightPanel } from '../components/right-panel';
import { NewChatModal } from '../components/new-chat';
import { SearchModal } from '../components/search-panel';
import { StoriesBar } from '../components/stories';
import { CallScreen, IncomingCallBanner } from '../components/call';
import { SettingsPage } from './settings';
import { Avatar, Badge, BrandMark, Button, EmptyState } from '../components/ui';
import { Icon } from '../components/icons';
import { useT } from '../lib/i18n';

/** Каркас: три колонки на десктопе, список ↔ чат на телефоне. */
export function MainShell() {
  const t = useT();
  const navigate = useNavigate();
  const user = useAppStore((state) => state.user);
  const activeChatId = useAppStore((state) => state.activeChatId);
  const setActiveChat = useAppStore((state) => state.setActiveChat);
  const mobileView = useAppStore((state) => state.mobileView);
  const rightPanel = useAppStore((state) => state.rightPanel);
  const setRightPanel = useAppStore((state) => state.setRightPanel);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="flex h-full min-h-0 bg-surface">
      <IncomingCallBanner />

      {/* Навигация (десктоп) */}
      <nav className="hidden w-[68px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface-raised py-3 lg:flex">
        <Link to="/" className="mb-2" aria-label="Элиан"><BrandMark compact /></Link>
        <NavButton icon="chat" label={t('nav.chats')} to="/" active />
        <NavButton icon="story" label="Истории" onClick={() => navigate('/stories')} />
        <NavButton icon="users" label={t('nav.contacts')} onClick={() => navigate('/contacts')} />
        <NavButton icon="archive" label={t('nav.archive')} onClick={() => navigate('/archive')} />
        <div className="mt-auto flex flex-col items-center gap-1">
          <NavButton icon="search" label={t('nav.search')} onClick={() => setSearchOpen(true)} />
          <NavButton icon="settings" label={t('nav.settings')} onClick={() => navigate('/settings')} />
          <Link to="/settings" className="mt-1" aria-label={user?.displayName}>
            <Avatar name={user?.displayName ?? '?'} src={user?.avatarUrl ?? null} size={36} />
          </Link>
        </div>
      </nav>

      <Routes>
        <Route
          path="/"
          element={
            <>
              <section className={`w-full flex-col border-r border-line lg:flex lg:w-[340px] ${mobileView === 'list' ? 'flex' : 'hidden'}`}>
                <StoriesBar />
                <div className="min-h-0 flex-1">
                  <ChatList onOpenSearch={() => setSearchOpen(true)} onNewChat={() => setNewChatOpen(true)} />
                </div>
              </section>
              <section className={`min-w-0 flex-1 ${mobileView === 'list' ? 'hidden lg:flex' : 'flex'}`}>
                <EmptyState
                  icon="sparkle"
                  title="Выберите чат"
                  description="Слева — ваши диалоги. Ctrl/⌘+K открывает поиск по людям, чатам и сообщениям."
                  action={<Button icon="plus" onClick={() => setNewChatOpen(true)}>Новый чат</Button>}
                />
              </section>
            </>
          }
        />
        <Route path="/chat/:chatId" element={<ChatRoute onPanel={() => setRightPanel(rightPanel === 'none' ? 'profile' : 'none')} />} />
        <Route path="/archive" element={
          <>
            <section className="flex w-full flex-col border-r border-line lg:w-[340px]">
              <div className="safe-top px-3 pt-3">
                <Link to="/" className="chip bg-surface-hover text-ink-muted"><Icon name="arrow-left" size={13} /> Назад</Link>
              </div>
              <div className="min-h-0 flex-1"><ChatList archived onOpenSearch={() => setSearchOpen(true)} onNewChat={() => setNewChatOpen(true)} /></div>
            </section>
          </>
        } />
        <Route path="/settings/*" element={<div className="min-w-0 flex-1"><SettingsPage /></div>} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/stories" element={<StoriesPage />} />
        <Route path="/call/:media/:peerId" element={<CallScreen />} />
        <Route path="/u/:username" element={<PublicProfilePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {rightPanel !== 'none' && activeChatId ? (
        <div className="hidden w-[330px] shrink-0 xl:block">
          <RightPanel chatId={activeChatId} onClose={() => setRightPanel('none')} />
        </div>
      ) : null}

      <NewChatModal open={newChatOpen} onClose={() => setNewChatOpen(false)} />
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

function NavButton({ icon, label, to, onClick, active }: { icon: string; label: string; to?: string; onClick?: () => void; active?: boolean }) {
  const className = `flex h-11 w-11 items-center justify-center rounded-xl2 transition ${active ? 'bg-brand-soft text-brand' : 'text-ink-muted hover:bg-surface-hover'}`;
  if (to) return <Link to={to} className={className} title={label} aria-label={label}><Icon name={icon} /></Link>;
  return <button className={className} onClick={onClick} title={label} aria-label={label}><Icon name={icon} /></button>;
}

function ChatRoute({ onPanel }: { onPanel: () => void }) {
  const { chatId = '' } = useParams();
  const setActiveChat = useAppStore((state) => state.setActiveChat);
  const setMobileView = useAppStore((state) => state.setMobileView);
  const rightPanel = useAppStore((state) => state.rightPanel);
  const mobileView = useAppStore((state) => state.mobileView);

  useEffect(() => {
    setActiveChat(chatId);
    setMobileView('chat');
  }, [chatId, setActiveChat, setMobileView]);

  return (
    <>
      <section className={`min-w-0 flex-1 ${mobileView === 'chat' || rightPanel !== 'none' ? 'flex' : 'hidden lg:flex'}`}>
        {chatId ? <ChatView chatId={chatId} onOpenPanel={onPanel} /> : null}
      </section>
      {rightPanel !== 'none' && chatId ? (
        <div className="fixed inset-0 z-50 bg-surface xl:hidden">
          <RightPanel chatId={chatId} onClose={() => useAppStore.getState().setRightPanel('none')} />
        </div>
      ) : null}
    </>
  );
}

function ContactsPage() {
  const query = useQuery({ queryKey: ['contacts-page'], queryFn: () => api.get<{ contacts: PublicUser[] }>('/contacts') });
  const contacts = query.data?.contacts ?? [];
  const navigate = useNavigate();
  return (
    <section className="min-w-0 flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2">
        <Link to="/" className="chip bg-surface-hover text-ink-muted"><Icon name="arrow-left" size={13} /> Назад</Link>
        <h1 className="text-lg font-semibold">Контакты</h1>
      </div>
      <div className="space-y-1">
        {contacts.map((user) => (
          <button
            key={user.id}
            className="chat-row"
            onClick={async () => {
              const result = await api.post<{ chat: { id: string } }>('/chats/private', { userId: user.id });
              navigate(`/chat/${result.chat.id}`);
            }}
          >
            <Avatar name={user.displayName} src={user.avatarUrl} size={44} seed={user.id} showOnline online={user.online} />
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate font-medium">{user.displayName}</span>
              <span className="block truncate text-xs text-ink-muted">@{user.username}</span>
            </span>
          </button>
        ))}
        {!contacts.length && !query.isLoading ? <EmptyState icon="users" title="Контактов пока нет" description="Добавляйте людей из профиля или поиска." /> : null}
      </div>
    </section>
  );
}

function StoriesPage() {
  const query = useQuery({ queryKey: ['stories-archive'], queryFn: () => api.get<{ stories: Array<{ id: string; kind: string; url: string | null; thumbUrl: string | null; text: string | null; viewCount: number; createdAt: string }> }>('/stories/archive/list') });
  const stories = query.data?.stories ?? [];
  return (
    <section className="min-w-0 flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2">
        <Link to="/" className="chip bg-surface-hover text-ink-muted"><Icon name="arrow-left" size={13} /> Назад</Link>
        <h1 className="text-lg font-semibold">Архив историй</h1>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {stories.map((story) => (
          <div key={story.id} className="overflow-hidden rounded-xl2 border border-line">
            {story.kind === 'text' ? (
              <div className="flex aspect-[9/16] items-center justify-center bg-brand p-3 text-center text-xs text-white">{story.text}</div>
            ) : (
              <img src={story.thumbUrl ?? story.url ?? ''} alt="" className="aspect-[9/16] w-full object-cover" />
            )}
            <div className="flex items-center justify-between px-2 py-1 text-[11px] text-ink-muted">
              <span>{new Date(story.createdAt).toLocaleDateString('ru-RU')}</span>
              <span className="flex items-center gap-1"><Icon name="eye" size={12} /> {story.viewCount}</span>
            </div>
          </div>
        ))}
      </div>
      {!stories.length && !query.isLoading ? <EmptyState icon="story" title="Архив пуст" description="Здесь остаются ваши истории после 24 часов." /> : null}
    </section>
  );
}

function PublicProfilePage() {
  const { username = '' } = useParams();
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ['profile', username], queryFn: () => api.get<{ user: PublicUser }>(`/users/${username}`) });
  const user = query.data?.user;
  if (query.isLoading) return <div className="flex flex-1 items-center justify-center text-sm text-ink-muted">Загрузка…</div>;
  if (!user) return <EmptyState icon="users" title="Пользователь не найден" description="Проверьте @username." />;
  return (
    <section className="flex min-w-0 flex-1 items-start justify-center overflow-y-auto p-6">
      <div className="surface-card w-full max-w-sm p-6 text-center">
        <Avatar name={user.displayName} src={user.avatarUrl} size={88} seed={user.id} />
        <h1 className="mt-3 text-lg font-semibold">{user.displayName}</h1>
        <p className="text-sm text-ink-muted">@{user.username}</p>
        {user.bio ? <p className="mt-2 text-sm">{user.bio}</p> : null}
        {user.isBot ? <Badge tone="muted">бот</Badge> : null}
        <div className="mt-4 flex justify-center gap-2">
          <Button
            onClick={async () => {
              const result = await api.post<{ chat: { id: string } }>('/chats/private', { userId: user.id });
              navigate(`/chat/${result.chat.id}`);
            }}
          >
            Написать
          </Button>
          <Button variant="soft" onClick={() => void api.post(`/contacts/${user.id}`).catch(() => undefined)}>В контакты</Button>
        </div>
      </div>
    </section>
  );
}
