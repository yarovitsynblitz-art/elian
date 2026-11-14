import { useEffect, useRef, useState } from 'react';
import type { PublicUser, Story } from '@elian/shared';
import { api } from '../lib/api';
import { Avatar, Button, Modal } from './ui';
import { Icon } from './icons';
import { useStories } from '../hooks/useElian';
import { useAppStore } from '../store/app';
import { uploadWithProgress } from '../lib/api';

interface StoryGroup {
  user: PublicUser;
  stories: Story[];
  allSeen: boolean;
}

export function StoriesBar() {
  const stories = useStories();
  const me = useAppStore((state) => state.user);
  const toast = useAppStore((state) => state.toast);
  const [viewing, setViewing] = useState<{ group: StoryGroup; index: number } | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function publish(file: File, kind: 'photo' | 'video') {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('kind', kind);
    try {
      const uploaded = await uploadWithProgress<{ media: { id: string } }>('/media/upload', formData);
      await api.post('/stories', { kind, mediaId: uploaded.media.id, privacy: 'contacts', duration: 5 });
      toast('История опубликована на 24 часа', 'success');
      await stories.refetch();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  const groups = stories.data ?? [];

  return (
    <div className="border-b border-line px-2 py-2">
      <div className="no-scrollbar flex gap-3 overflow-x-auto px-1 pb-1">
        <button className="flex w-16 flex-col items-center gap-1" onClick={() => setComposerOpen(true)}>
          <span className="relative">
            <Avatar name={me?.displayName ?? 'Я'} src={me?.avatarUrl} size={52} />
            <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-surface bg-brand text-white">
              <Icon name="plus" size={11} />
            </span>
          </span>
          <span className="w-full truncate text-center text-[11px] text-ink-muted">Моя история</span>
        </button>
        {groups.map((group) => (
          <button
            key={group.user.id}
            className="flex w-16 flex-col items-center gap-1"
            onClick={() => setViewing({ group, index: 0 })}
          >
            <span className={`rounded-full p-[2px] ${group.allSeen ? 'bg-line' : 'bg-gradient-to-tr from-brand to-accent'}`}>
              <span className="block rounded-full border-2 border-surface">
                <Avatar name={group.user.displayName} src={group.user.avatarUrl} size={48} seed={group.user.id} />
              </span>
            </span>
            <span className="w-full truncate text-center text-[11px] text-ink-muted">{group.user.displayName}</span>
          </button>
        ))}
        {!groups.length ? <span className="self-center px-2 text-[11px] text-ink-faint">Поделитесь моментом — история живёт 24 часа</span> : null}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void publish(file, file.type.startsWith('video/') ? 'video' : 'photo');
          setComposerOpen(false);
        }}
      />
      <Modal open={composerOpen} onClose={() => setComposerOpen(false)} title="Новая история">
        <div className="space-y-3">
          <Button className="w-full" icon="image" onClick={() => fileRef.current?.click()}>Фото или видео</Button>
          <StoryTextComposer onDone={() => { setComposerOpen(false); void stories.refetch(); }} />
          <p className="text-[11px] text-ink-faint">Приватность: контакты. Изменить можно в настройках приватности.</p>
        </div>
      </Modal>

      {viewing ? (
        <StoryViewer
          group={viewing.group}
          index={viewing.index}
          onClose={() => setViewing(null)}
          onNavigate={(index) => setViewing({ group: viewing.group, index })}
        />
      ) : null}
    </div>
  );
}

function StoryTextComposer({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const toast = useAppStore((state) => state.toast);
  return (
    <>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Текст истории…"
        className="field min-h-[100px]"
        maxLength={700}
      />
      <Button
        className="w-full"
        disabled={!text.trim()}
        onClick={async () => {
          try {
            await api.post('/stories', { kind: 'text', text, background: 'linear-gradient(135deg,#4B3AF0,#12C2B4)', privacy: 'contacts', duration: 5 });
            toast('История опубликована', 'success');
            onDone();
          } catch (error) {
            toast((error as Error).message, 'error');
          }
        }}
      >
        Опубликовать текст
      </Button>
    </>
  );
}

function StoryViewer({ group, index, onClose, onNavigate }: { group: StoryGroup; index: number; onClose: () => void; onNavigate: (index: number) => void }) {
  const story = group.stories[index];
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!story) return;
    void api.post(`/stories/${story.id}/view`).catch(() => undefined);
    setProgress(0);
    const duration = (story.duration || 5) * 1000;
    const start = Date.now();
    const timer = setInterval(() => {
      const percent = Math.min(100, ((Date.now() - start) / duration) * 100);
      setProgress(percent);
      if (percent >= 100) {
        clearInterval(timer);
        if (index + 1 < group.stories.length) onNavigate(index + 1);
        else onClose();
      }
    }, 60);
    return () => clearInterval(timer);
  }, [story?.id, index]);

  if (!story) return null;

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black/90 animate-fade-in">
      <div className="flex gap-1 px-3 pt-3">
        {group.stories.map((item, itemIndex) => (
          <span key={item.id} className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/25">
            <span
              className="block h-full bg-white transition-all"
              style={{ width: itemIndex < index ? '100%' : itemIndex === index ? `${progress}%` : '0%' }}
            />
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2 px-4 py-2 text-white">
        <Avatar name={group.user.displayName} src={group.user.avatarUrl} size={34} />
        <div>
          <div className="text-sm font-semibold">{group.user.displayName}</div>
          <div className="text-[11px] text-white/60">{new Date(story.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <button className="ml-auto text-white/80" onClick={onClose} aria-label="Закрыть"><Icon name="close" /></button>
      </div>
      <div className="relative flex flex-1 items-center justify-center overflow-hidden p-4">
        {story.kind === 'text' ? (
          <div className="flex h-full w-full items-center justify-center rounded-xl3 p-8 text-center text-xl font-semibold text-white" style={{ background: story.background ?? '#4B3AF0' }}>
            {story.text}
          </div>
        ) : story.kind === 'video' ? (
          <video src={story.url ?? undefined} autoPlay controls className="max-h-full max-w-full rounded-xl2" />
        ) : (
          <img src={story.url ?? ''} alt="" className="max-h-full max-w-full rounded-xl2 object-contain" />
        )}
        <button className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white" onClick={() => onNavigate(Math.max(0, index - 1))} aria-label="Предыдущая">
          <Icon name="chevron-left" />
        </button>
        <button className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white" onClick={() => (index + 1 < group.stories.length ? onNavigate(index + 1) : onClose())} aria-label="Следующая">
          <Icon name="chevron-right" />
        </button>
      </div>
      <div className="flex items-center gap-2 px-4 pb-6">
        <input placeholder="Ответить на историю…" className="field flex-1 bg-white/10 text-white placeholder:text-white/50" onKeyDown={async (event) => {
          if (event.key !== 'Enter') return;
          const value = (event.target as HTMLInputElement).value.trim();
          if (!value) return;
          await api.post(`/stories/${story.id}/reaction`, { emoji: '💬', replyText: value }).catch(() => undefined);
          (event.target as HTMLInputElement).value = '';
        }} />
        <button className="rounded-full bg-white/15 px-3 py-2 text-lg" onClick={() => void api.post(`/stories/${story.id}/reaction`, { emoji: '❤️' }).catch(() => undefined)}>❤️</button>
      </div>
    </div>
  );
}
