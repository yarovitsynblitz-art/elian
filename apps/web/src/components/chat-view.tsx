import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import type { ChatSummary, Message, PublicUser } from '@elian/shared';
import { api } from '../lib/api';
import { useAppStore } from '../store/app';
import { useChat, useChatActions, useChatMessages, useChatSearch, useTypingIndicator } from '../hooks/useElian';
import { Avatar, Badge, Button, EmptyState, Modal, Spinner } from './ui';
import { Icon } from './icons';
import { MessageContent } from './message-content';
import { Composer } from './composer';
import { formatDateLabel, formatTime, lastSeenLabel } from './format';
import { useT } from '../lib/i18n';

const REACTIONS = ['👍', '❤️', '🔥', '😂', '🎉', '🙏', '😮', '😢'];

export function ChatView({ chatId, onOpenPanel }: { chatId: string; onOpenPanel: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const chatQuery = useChat(chatId);
  const chat = chatQuery.data?.chat;
  const peer = chatQuery.data?.peer;
  const { messages, isLoading, loadOlder, hasMore } = useChatMessages(chatId);
  const actions = useChatActions(chatId);
  const reply = useAppStore((state) => state.composerReply);
  const edit = useAppStore((state) => state.composerEdit);
  const setReply = useAppStore((state) => state.setComposerReply);
  const setEdit = useAppStore((state) => state.setComposerEdit);
  const setMobileView = useAppStore((state) => state.setMobileView);
  const toast = useAppStore((state) => state.toast);
  const typingMap = useTypingIndicator(chatId);
  const [menuFor, setMenuFor] = useState<Message | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const search = useChatSearch(chatId, searchQuery);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const initialReadDone = useRef(false);

  useEffect(() => {
    initialReadDone.current = false;
    setSearchOpen(false);
    setSearchQuery('');
  }, [chatId]);

  useEffect(() => {
    if (!messages.length) return;
    if (!initialReadDone.current) {
      initialReadDone.current = true;
      bottomRef.current?.scrollIntoView({ block: 'end' });
      const last = messages[messages.length - 1]!;
      actions.markRead.mutate(last.seq);
      return;
    }
    if (atBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      const last = messages[messages.length - 1]!;
      actions.markRead.mutate(last.seq);
    }
  }, [messages.length]);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const onScroll = () => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      setAtBottom(distance < 120);
      if (element.scrollTop < 80 && hasMore) void loadOlder();
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [hasMore, loadOlder]);

  const grouped = useMemo(() => {
    const groups: Array<{ date: string; items: Message[] }> = [];
    for (const message of messages) {
      const day = message.createdAt.slice(0, 10);
      const existing = groups[groups.length - 1];
      if (existing && existing.date === day) existing.items.push(message);
      else groups.push({ date: day, items: [message] });
    }
    return groups;
  }, [messages]);

  const typingUsers = [...typingMap.keys()].filter((userId) => userId !== messages.find((message) => message.isOutgoing)?.senderId);

  if (chatQuery.isLoading || isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size={28} />
      </div>
    );
  }

  if (!chat) {
    return <EmptyState icon="chat" title="Чат недоступен" description="Возможно, вас удалили из чата." />;
  }

  const subtitle = chat.type === 'private'
    ? (peer ? lastSeenLabel(peer.lastSeenAt, peer.online) : '')
    : `${chat.memberCount} ${chat.type === 'channel' ? t('chat.subscribers') : t('chat.members')}${chat.username ? ` · @${chat.username}` : ''}`;

  function scrollToMessage(messageId: string) {
    const element = document.getElementById(`message-${messageId}`);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightId(messageId);
    setTimeout(() => setHighlightId(null), 1600);
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="safe-top flex items-center gap-2 border-b border-line px-2 py-2">
        <button
          className="icon-btn lg:hidden"
          onClick={() => { setMobileView('list'); navigate('/'); }}
          aria-label={t('common.back')}
        >
          <Icon name="arrow-left" />
        </button>
        <button className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl2 px-1.5 py-1 text-left hover:bg-surface-hover" onClick={onOpenPanel}>
          <Avatar name={chat.title} src={chat.avatarUrl} size={40} seed={chat.id} showOnline={chat.type === 'private'} online={peer?.online} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold">{chat.title}</span>
              {chat.type === 'channel' ? <Icon name="volume-x" size={13} className="text-ink-faint" /> : null}
            </span>
            <span className="block truncate text-[11px] text-ink-muted">
              {typingUsers.length
                ? <span className="text-brand">{t('chat.typing')}</span>
                : subtitle}
            </span>
          </span>
        </button>
        <button className="icon-btn" onClick={() => setSearchOpen((value) => !value)} aria-label="Поиск в чате"><Icon name="search" /></button>
        {chat.type === 'private' && peer ? (
          <>
            <button
              className="icon-btn hidden sm:inline-flex"
              aria-label="Аудиозвонок"
              onClick={() => navigate(`/call/audio/${peer.id}`)}
            >
              <Icon name="phone" />
            </button>
            <button
              className="icon-btn hidden sm:inline-flex"
              aria-label="Видеозвонок"
              onClick={() => navigate(`/call/video/${peer.id}`)}
            >
              <Icon name="video" />
            </button>
          </>
        ) : null}
        <button className="icon-btn" onClick={() => setShowInfo(true)} aria-label="Информация"><Icon name="more" /></button>
      </header>

      {searchOpen ? (
        <div className="border-b border-line bg-surface-raised px-3 py-2">
          <input
            autoFocus
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Поиск в этом чате"
            className="field"
          />
          {searchQuery.trim() ? (
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
              {search.isLoading ? <p className="text-xs text-ink-muted">{t('common.loading')}</p> : null}
              {search.data?.messages.length === 0 ? <p className="text-xs text-ink-muted">Ничего не найдено</p> : null}
              {search.data?.messages.map((message) => (
                <button
                  key={message.id}
                  className="block w-full rounded-lg px-2 py-1.5 text-left text-xs hover:bg-surface-hover"
                  onClick={() => { setSearchOpen(false); setTimeout(() => scrollToMessage(message.id), 60); }}
                >
                  <span className="font-semibold">{message.sender?.displayName ?? '—'}</span>
                  <span className="ml-2 text-ink-muted">{formatTime(message.createdAt)}</span>
                  <span className="mt-0.5 block truncate">{message.text}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {chat.pinnedMessageId ? (
        <button
          className="flex items-center gap-2 border-b border-line bg-surface-raised px-3 py-2 text-left"
          onClick={() => scrollToMessage(chat.pinnedMessageId!)}
        >
          <Icon name="pin" size={15} className="text-brand" />
          <span className="min-w-0 flex-1">
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-brand">{t('chat.pinnedMessage')}</span>
            <span className="block truncate text-xs text-ink-muted">
              {messages.find((message) => message.id === chat.pinnedMessageId)?.text ?? 'Нажмите, чтобы перейти'}
            </span>
          </span>
        </button>
      ) : null}

      <div ref={scrollerRef} className="wallpaper flex-1 overflow-y-auto px-2 py-3 sm:px-4">
        {hasMore ? (
          <div className="mb-2 flex justify-center">
            <Button size="sm" variant="soft" onClick={() => void loadOlder()}>Загрузить раньше</Button>
          </div>
        ) : null}
        {!messages.length ? (
          <EmptyState icon="sparkle" title="Пока пусто" description="Отправьте первое сообщение — оно появится у всех участников." />
        ) : null}
        {grouped.map((group) => (
          <div key={group.date}>
            <div className="my-3 flex justify-center">
              <span className="chip bg-surface/80 text-[11px] text-ink-muted backdrop-blur">{formatDateLabel(group.items[0]!.createdAt)}</span>
            </div>
            {group.items.map((message, index) => {
              const previous = group.items[index - 1];
              const sameSender = previous && previous.senderId === message.senderId
                && new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 4 * 60_000;
              return (
                <MessageRow
                  key={message.id}
                  message={message}
                  chat={chat}
                  grouped={Boolean(sameSender)}
                  highlighted={highlightId === message.id}
                  onReply={() => { setReply(message); setEdit(null); }}
                  onEdit={() => { setEdit(message); setReply(null); }}
                  onDelete={() => setMenuFor(message)}
                  onReact={(emoji) => {
                    const existing = message.reactions.find((reaction) => reaction.emoji === emoji);
                    actions.toggleReaction.mutate({ messageId: message.id, emoji, active: !existing?.byMe });
                  }}
                  onVote={(optionIds) => {
                    if (message.poll) actions.votePoll.mutate({ pollId: message.poll.id, optionIds });
                  }}
                  onOpenMenu={() => setMenuFor(message)}
                />
              );
            })}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {!atBottom ? (
        <div className="relative">
          <button
            className="absolute -top-14 right-4 flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface text-ink shadow-lg"
            onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
            aria-label={t('chat.scrollBottom')}
          >
            <Icon name="arrow-down" />
          </button>
        </div>
      ) : null}

      <Composer chat={chat} reply={reply} edit={edit} />

      <Modal open={Boolean(menuFor)} onClose={() => setMenuFor(null)} title="Действия с сообщением">
        {menuFor ? (
          <div className="space-y-1">
            <ActionRow icon="reply" label={t('chat.reply')} onClick={() => { setReply(menuFor); setMenuFor(null); }} />
            {menuFor.isOutgoing ? (
              <ActionRow icon="edit" label={t('chat.edit')} onClick={() => { setEdit(menuFor); setMenuFor(null); }} />
            ) : null}
            <ActionRow
              icon="forward"
              label={t('chat.forward')}
              onClick={async () => {
                try {
                  const forward = await api.post<{ chat: ChatSummary }>('/messages/forward', { messageIds: [menuFor.id], toChatId: chatId });
                  toast('Переслано в текущий чат', 'success');
                  void forward;
                } catch (error) {
                  toast((error as Error).message, 'error');
                }
                setMenuFor(null);
              }}
            />
            <ActionRow icon="copy" label={t('chat.copy')} onClick={() => { void navigator.clipboard.writeText(menuFor.text); setMenuFor(null); toast('Скопировано', 'success'); }} />
            <ActionRow
              icon="pin"
              label={menuFor.pinned ? t('chat.unpin') : t('chat.pin')}
              onClick={() => { actions.pinMessage.mutate({ messageId: menuFor.id, pinned: !menuFor.pinned }); setMenuFor(null); }}
            />
            <ActionRow
              icon="trash"
              danger
              label={t('chat.delete')}
              onClick={() => { actions.deleteMessage.mutate({ messageId: menuFor.id, forEveryone: true }); setMenuFor(null); }}
            />
          </div>
        ) : null}
      </Modal>

      <Modal open={showInfo} onClose={() => setShowInfo(false)} title={chat.title}>
        <ChatInfo chat={chat} peer={peer} onOpenPanel={() => { setShowInfo(false); onOpenPanel(); }} />
      </Modal>
    </div>
  );
}

function ActionRow({ icon, label, onClick, danger }: { icon: string; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={clsx('flex w-full items-center gap-3 rounded-xl2 px-3 py-2.5 text-left text-sm hover:bg-surface-hover', danger && 'text-danger')}>
      <Icon name={icon} size={18} />
      {label}
    </button>
  );
}

function ChatInfo({ chat, peer, onOpenPanel }: { chat: ChatSummary; peer?: PublicUser; onOpenPanel: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="space-y-3">
      <div className="flex flex-col items-center gap-2 text-center">
        <Avatar name={chat.title} src={chat.avatarUrl} size={72} seed={chat.id} />
        <div>
          <div className="text-base font-semibold">{chat.title}</div>
          <div className="text-xs text-ink-muted">
            {chat.type === 'private' ? (peer ? lastSeenLabel(peer.lastSeenAt, peer.online) : 'личный чат') : `${chat.memberCount} участников`}
          </div>
        </div>
        {chat.username ? <Badge tone="muted">@{chat.username}</Badge> : null}
      </div>
      {chat.description ? <p className="rounded-xl2 bg-surface-hover p-3 text-xs text-ink-muted">{chat.description}</p> : null}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="soft" icon="users" onClick={onOpenPanel}>Участники</Button>
        <Button variant="soft" icon="image" onClick={onOpenPanel}>Медиа</Button>
        {chat.type === 'private' && peer ? (
          <>
            <Button variant="soft" icon="phone" onClick={() => navigate(`/call/audio/${peer.id}`)}>Звонок</Button>
            <Button variant="soft" icon="video" onClick={() => navigate(`/call/video/${peer.id}`)}>Видео</Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function MessageRow({
  message,
  chat,
  grouped,
  highlighted,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onVote,
  onOpenMenu,
}: {
  message: Message;
  chat: ChatSummary;
  grouped: boolean;
  highlighted: boolean;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onReact: (emoji: string) => void;
  onVote: (optionIds: string[]) => void;
  onOpenMenu: () => void;
}) {
  const outgoing = message.isOutgoing;
  const deleted = Boolean(message.deletedAt);
  const [showReactions, setShowReactions] = useState(false);
  const showAuthor = chat.type !== 'private' && !outgoing && !grouped;
  const signature = message.authorSignature;
  return (
    <div
      id={`message-${message.id}`}
      className={clsx('group flex gap-2 px-1', outgoing ? 'justify-end' : 'justify-start', grouped ? 'mt-0.5' : 'mt-2', highlighted && 'msg-highlight rounded-xl2')}
      onDoubleClick={(event) => { event.preventDefault(); onReply(); }}
    >
      {!outgoing ? (
        <div className="w-8 shrink-0">
          {!grouped ? (
            <Avatar name={message.sender?.displayName ?? '?'} src={message.sender?.avatarUrl} size={30} seed={message.senderId ?? 'x'} />
          ) : null}
        </div>
      ) : null}
      <div className={clsx('relative max-w-[min(80vw,34rem)]', outgoing ? 'items-end' : 'items-start')}>
        {showAuthor ? (
          <div className="mb-0.5 px-1 text-[11px] font-semibold text-brand">{message.sender?.displayName ?? 'Участник'}</div>
        ) : null}
        <div
          className={clsx(
            'bubble shadow-sm',
            outgoing ? 'bg-bubble-out text-bubble-out-ink bubble-tail rounded-br-md' : 'bg-bubble-in bubble-tail-in rounded-bl-md',
          )}
        >
          {deleted ? (
            <p className="italic text-ink-muted">Сообщение удалено</p>
          ) : (
            <MessageContent message={message} onVote={onVote} />
          )}
          <div className={clsx('mt-1 flex items-center gap-1.5 text-[10px]', outgoing ? 'justify-end text-bubble-out-ink/70' : 'justify-end text-ink-faint')}>
            {signature ? <span className="mr-auto italic">{signature}</span> : null}
            {message.silent ? <Icon name="bell" size={10} /> : null}
            {message.pinned ? <Icon name="pin" size={10} /> : null}
            <span className="tabular-nums">{formatTime(message.createdAt)}</span>
            {message.editedAt ? <span>· изменено</span> : null}
            {outgoing ? (
              <span aria-label={message.readByAll ? 'прочитано' : message.deliveredToAll ? 'доставлено' : 'отправлено'}>
                <Icon
                  name={message.readByAll ? 'check-double' : message.deliveredToAll ? 'check-double' : 'check'}
                  size={13}
                  className={message.readByAll ? 'text-brand' : 'opacity-70'}
                />
              </span>
            ) : null}
          </div>
        </div>

        {message.reactions.length ? (
          <div className={clsx('mt-1 flex flex-wrap gap-1', outgoing ? 'justify-end' : 'justify-start')}>
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                onClick={() => onReact(reaction.emoji)}
                className={clsx(
                  'chip border text-[11px]',
                  reaction.byMe ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-surface text-ink-muted',
                )}
                aria-label={`Реакция ${reaction.count}`}
              >
                <span aria-hidden="true">{reaction.emoji}</span> {reaction.count}
              </button>
            ))}
          </div>
        ) : null}

        <div className={clsx('absolute -top-3 z-10 hidden items-center gap-0.5 rounded-full border border-line bg-surface px-1 py-0.5 shadow group-hover:flex', outgoing ? 'left-0' : 'right-0')}>
          <button
            className="rounded-full p-1 text-ink-muted hover:bg-surface-hover"
            onClick={() => setShowReactions((value) => !value)}
            aria-label="Реакция"
          >
            <Icon name="heart" size={14} />
          </button>
          <button className="rounded-full p-1 text-ink-muted hover:bg-surface-hover" onClick={onReply} aria-label="Ответить">
            <Icon name="reply" size={14} />
          </button>
          <button className="rounded-full p-1 text-ink-muted hover:bg-surface-hover" onClick={onOpenMenu} aria-label="Ещё">
            <Icon name="more" size={14} />
          </button>
        </div>

        {showReactions ? (
          <div className={clsx('absolute -top-9 z-20 flex gap-0.5 rounded-full border border-line bg-surface px-1.5 py-1 shadow-lg', outgoing ? 'right-0' : 'left-0')}>
            {REACTIONS.map((emoji) => (
              <button
                key={emoji}
                className="rounded-full px-1 text-lg hover:bg-surface-hover"
                onClick={() => { onReact(emoji); setShowReactions(false); }}
              >
                {emoji}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
