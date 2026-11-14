import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChatSummary, Folder } from '@elian/shared';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useAppStore, useChatIndex } from '../store/app';
import { useT } from '../lib/i18n';
import { Avatar, Badge, Button, EmptyState, Modal, SkeletonList } from './ui';
import { Icon } from './icons';
import { useChats, useFolders } from '../hooks/useElian';

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const diffDays = Math.round((now.getTime() - date.getTime()) / 86_400_000);
  if (diffDays < 7) return date.toLocaleDateString('ru-RU', { weekday: 'short' });
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function folderMatches(folder: Folder, chat: ChatSummary): boolean {
  if (folder.excludedChatIds.includes(chat.id)) return false;
  if (folder.includedChatIds.includes(chat.id)) return true;
  if (!folder.rules.length) return false;
  return folder.rules.every((rule) => {
    let matched = false;
    if (rule.type === 'chat') matched = chat.id === rule.value;
    if (rule.type === 'type') matched = chat.type === rule.value;
    if (rule.type === 'unread') matched = chat.unreadCount > 0;
    if (rule.type === 'pinned') matched = chat.pinned;
    if (rule.type === 'muted') matched = chat.muted;
    if (rule.type === 'contact') matched = Boolean(chat.lastMessageSenderId);
    if (rule.type === 'hasMedia') matched = Boolean(chat.lastMessagePreview?.startsWith('📎'));
    return rule.include ? matched : !matched;
  });
}

interface MenuState {
  chat: ChatSummary;
  x: number;
  y: number;
}

export function ChatList({
  onOpenSearch,
  onNewChat,
  archived = false,
}: {
  onOpenSearch: () => void;
  onNewChat: () => void;
  archived?: boolean;
}) {
  const t = useT();
  const navigate = useNavigate();
  const activeChatId = useAppStore((state) => state.activeChatId);
  const setActiveChat = useAppStore((state) => state.setActiveChat);
  const setMobileView = useAppStore((state) => state.setMobileView);
  const toast = useAppStore((state) => state.toast);
  // ВАЖНО: селектор не должен создавать новый массив на каждый вызов (zustand v5),
  // иначе useSyncExternalStore уходит в бесконечный ре-рендер.
  const chatsMap = useChatIndex((state) => state.chats);
  const chats = useMemo(() => [...chatsMap.values()], [chatsMap]);
  const chatsQuery = useChats(archived);
  const foldersQuery = useFolders();
  const [query, setQuery] = useState('');
  const [activeFolder, setActiveFolder] = useState<string>('all');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [multiSelect, setMultiSelect] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const me = useAppStore((state) => state.user);

  const folders = foldersQuery.data ?? [];

  const visible = useMemo(() => {
    let list = chats.filter((chat) => Boolean(chat.archived) === archived);
    if (activeFolder !== 'all') {
      const folder = folders.find((item) => item.id === activeFolder);
      if (folder) list = list.filter((chat) => folderMatches(folder, chat));
    }
    if (query.trim()) {
      const lower = query.toLowerCase();
      list = list.filter((chat) => chat.title.toLowerCase().includes(lower) || (chat.username ?? '').includes(lower));
    }
    return list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '');
    });
  }, [chats, archived, activeFolder, folders, query]);

  function openChat(chat: ChatSummary) {
    if (selectMode) {
      const next = new Set(multiSelect);
      if (next.has(chat.id)) next.delete(chat.id);
      else next.add(chat.id);
      setMultiSelect(next);
      return;
    }
    setActiveChat(chat.id);
    setMobileView('chat');
    navigate(`/chat/${chat.id}`);
  }

  async function chatAction(chat: ChatSummary, action: string) {
    try {
      if (action === 'pin') await api.post(`/chats/${chat.id}/pin`, { value: !chat.pinned });
      if (action === 'archive') await api.post(`/chats/${chat.id}/archive`, { value: !chat.archived });
      if (action === 'mute') await api.post(`/chats/${chat.id}/mute`, { value: !chat.muted });
      if (action === 'read') {
        await api.post(`/chats/${chat.id}/read`, { upToSeq: 2 ** 31 - 1 });
      }
      if (action === 'delete' || action === 'leave') await api.del(`/chats/${chat.id}`);
      const refreshed = await api.get<{ chats: ChatSummary[] }>('/chats');
      useChatIndex.getState().setChats(refreshed.chats);
      toast('Готово', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Ошибка', 'error');
    } finally {
      setMenu(null);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top px-3 pt-3">
        <div className="flex items-center justify-between gap-2 px-1 pb-2">
          <div className="flex items-center gap-2">
            {/* На телефоне бокового меню нет — вход в настройки и разделы через аватар. */}
            <div className="relative lg:hidden">
              <button
                className="flex h-9 w-9 items-center justify-center rounded-full"
                onClick={() => setMobileMenu((value) => !value)}
                aria-label="Меню"
                aria-expanded={mobileMenu}
              >
                <Avatar name={me?.displayName ?? '?'} src={me?.avatarUrl ?? null} size={34} />
              </button>
              {mobileMenu ? (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setMobileMenu(false)} />
                  <div className="absolute left-0 top-11 z-40 w-56 overflow-hidden rounded-xl2 border border-line bg-surface-raised py-1 shadow-xl">
                    {[
                      { label: t('nav.settings'), icon: 'settings', to: '/settings' },
                      { label: t('nav.contacts'), icon: 'users', to: '/contacts' },
                      { label: 'Истории', icon: 'story', to: '/stories' },
                      { label: t('nav.archive'), icon: 'archive', to: '/archive' },
                    ].map((item) => (
                      <button
                        key={item.to}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-hover"
                        onClick={() => { setMobileMenu(false); navigate(item.to); }}
                      >
                        <Icon name={item.icon as never} size={16} />{item.label}
                      </button>
                    ))}
                    <button
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-hover"
                      onClick={() => { setMobileMenu(false); onOpenSearch(); }}
                    >
                      <Icon name="search" size={16} />{t('nav.search')}
                    </button>
                  </div>
                </>
              ) : null}
            </div>
            <h1 className="text-lg font-semibold">{archived ? t('nav.archive') : t('nav.chats')}</h1>
          </div>
          <div className="flex items-center gap-1">
            <button className="icon-btn" onClick={onOpenSearch} aria-label={t('nav.search')}><Icon name="search" /></button>
            <button className="icon-btn" onClick={onNewChat} aria-label={t('chats.newChat')}><Icon name="plus" /></button>
          </div>
        </div>
        <div className="px-1 pb-2">
          <div className="relative">
            <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={onOpenSearch}
              placeholder={t('chats.search')}
              className="w-full rounded-xl2 border border-line bg-surface-raised py-2 pl-9 pr-3 text-sm outline-none focus:border-brand"
              aria-label={t('chats.search')}
            />
          </div>
        </div>
        <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-1 pb-2">
          <button
            data-active={activeFolder === 'all'}
            onClick={() => setActiveFolder('all')}
            className="chip bg-surface-hover text-ink-muted data-[active=true]:bg-brand data-[active=true]:text-white"
          >
            {t('chats.all')}
          </button>
          <button
            data-active={activeFolder === 'unread'}
            onClick={() => setActiveFolder('unread')}
            className="chip bg-surface-hover text-ink-muted data-[active=true]:bg-brand data-[active=true]:text-white"
          >
            {t('chats.unread')}
          </button>
          {folders.map((folder) => (
            <button
              key={folder.id}
              data-active={activeFolder === folder.id}
              onClick={() => setActiveFolder(folder.id)}
              className="chip bg-surface-hover text-ink-muted data-[active=true]:bg-brand data-[active=true]:text-white"
            >
              {folder.emoji ? `${folder.emoji} ` : ''}{folder.name}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-1.5 pb-3">
        {chatsQuery.isLoading ? <SkeletonList /> : null}
        {!chatsQuery.isLoading && !visible.length ? (
          <EmptyState icon="chat" title={t('chats.empty')} description={t('chats.emptyHint')} action={<Button onClick={onNewChat} icon="plus">{t('chats.newChat')}</Button>} />
        ) : null}
        {visible
          .filter((chat) => (activeFolder === 'unread' ? chat.unreadCount > 0 : true))
          .map((chat) => (
            <button
              key={chat.id}
              className="chat-row"
              data-active={chat.id === activeChatId}
              onClick={() => openChat(chat)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ chat, x: event.clientX, y: event.clientY });
              }}
              onDoubleClick={() => setMenu({ chat, x: 0, y: 0 })}
            >
              <Avatar
                name={chat.title}
                src={chat.avatarUrl}
                size={52}
                seed={chat.id}
                showOnline={chat.type === 'private'}
                online={!chat.muted && chat.unreadCount > 0 ? true : undefined}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[0.95rem] font-semibold">{chat.title}</span>
                  {chat.type === 'channel' ? <Icon name="volume-x" size={13} className="text-ink-faint" /> : null}
                  {chat.type === 'group' ? <Icon name="users" size={13} className="text-ink-faint" /> : null}
                  {chat.muted ? <Icon name="volume-x" size={13} className="text-ink-faint" /> : null}
                  <span className="ml-auto shrink-0 text-[11px] text-ink-faint">{formatTime(chat.lastMessageAt)}</span>
                </span>
                <span className="mt-0.5 flex items-center gap-1.5">
                  {chat.draftText ? (
                    <span className="truncate text-xs text-danger">
                      <span className="font-semibold">{t('chats.draft')}: </span>{chat.draftText}
                    </span>
                  ) : (
                    <span className="truncate text-xs text-ink-muted">
                      {chat.lastMessagePreview ?? t('chats.noMessages')}
                    </span>
                  )}
                  {chat.pinned ? <Icon name="pin" size={12} className="ml-auto shrink-0 text-ink-faint" /> : null}
                  {chat.unreadCount > 0 ? (
                    <span className={clsx('ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-bold text-white', chat.muted ? 'bg-ink-faint' : 'bg-brand')}>
                      {chat.unreadCount > 99 ? '99+' : chat.unreadCount}
                    </span>
                  ) : null}
                </span>
              </span>
            </button>
          ))}
      </div>

      <Modal open={Boolean(menu)} onClose={() => setMenu(null)} title={menu?.chat.title ?? ''}>
        {menu ? (
          <div className="space-y-1 pb-2">
            <MenuRow icon="check" label="Отметить прочитанным" onClick={() => chatAction(menu.chat, 'read')} />
            <MenuRow icon="pin" label={menu.chat.pinned ? t('chat.unpin') : t('chat.pin')} onClick={() => chatAction(menu.chat, 'pin')} />
            <MenuRow icon="archive" label={menu.chat.archived ? 'Вернуть из архива' : 'В архив'} onClick={() => chatAction(menu.chat, 'archive')} />
            <MenuRow icon="volume-x" label={menu.chat.muted ? 'Включить звук' : 'Без звука'} onClick={() => chatAction(menu.chat, 'mute')} />
            <MenuRow
              icon="trash"
              label={menu.chat.role === 'owner' && menu.chat.type !== 'private' ? 'Удалить чат' : 'Покинуть чат'}
              danger
              onClick={() => chatAction(menu.chat, menu.chat.role === 'owner' && menu.chat.type !== 'private' ? 'delete' : 'leave')}
            />
            <MenuRow icon="users" label="Выбрать несколько" onClick={() => { setSelectMode(true); setMenu(null); }} />
          </div>
        ) : null}
      </Modal>

      {selectMode ? (
        <div className="safe-bottom flex items-center justify-between gap-2 border-t border-line bg-surface-raised px-3 py-2">
          <span className="text-xs text-ink-muted">Выбрано: {multiSelect.size}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setSelectMode(false); setMultiSelect(new Set()); }}>Отмена</Button>
            <Button
              size="sm"
              onClick={async () => {
                for (const id of multiSelect) {
                  await api.post(`/chats/${id}/archive`, { value: !archived }).catch(() => undefined);
                }
                const refreshed = await api.get<{ chats: ChatSummary[] }>('/chats');
                useChatIndex.getState().setChats(refreshed.chats);
                setSelectMode(false);
                setMultiSelect(new Set());
              }}
            >
              {archived ? 'Вернуть' : 'В архив'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MenuRow({ icon, label, onClick, danger }: { icon: string; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={clsx('flex w-full items-center gap-3 rounded-xl2 px-3 py-2.5 text-left text-sm hover:bg-surface-hover', danger && 'text-danger')}
    >
      <Icon name={icon} size={18} />
      {label}
    </button>
  );
}

export { Badge };
