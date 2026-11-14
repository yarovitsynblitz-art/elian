import { useState } from 'react';
import clsx from 'clsx';
import type { Attachment, Message, MessageEntity } from '@elian/shared';
import { Icon } from './icons';
import { formatBytes } from './format';

function renderEntities(text: string, entities: MessageEntity[]) {
  if (!entities.length) return text;
  const points = new Set<number>([0, text.length]);
  for (const entity of entities) {
    points.add(Math.max(0, Math.min(entity.offset, text.length)));
    points.add(Math.max(0, Math.min(entity.offset + entity.length, text.length)));
  }
  const sorted = [...points].sort((a, b) => a - b);
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i]!;
    const end = sorted[i + 1]!;
    const slice = text.slice(start, end);
    if (!slice) continue;
    const active = entities.filter((entity) => entity.offset <= start && entity.offset + entity.length >= end);
    let node: React.ReactNode = slice;
    for (const entity of active) {
      switch (entity.type) {
        case 'bold': node = <strong>{node}</strong>; break;
        case 'italic': node = <em>{node}</em>; break;
        case 'underline': node = <u>{node}</u>; break;
        case 'strike': node = <s>{node}</s>; break;
        case 'code': node = <code className="rounded bg-black/10 px-1 font-mono text-[0.85em]">{node}</code>; break;
        case 'pre': node = <pre className="my-1 overflow-x-auto rounded-lg bg-black/10 p-2 font-mono text-xs">{node}</pre>; break;
        case 'spoiler': node = <Spoiler>{node}</Spoiler>; break;
        case 'mention': node = <span className="font-medium text-brand">{node}</span>; break;
        case 'hashtag': node = <span className="font-medium text-brand">{node}</span>; break;
        case 'text_link': node = (
          <a href={entity.url} target="_blank" rel="noopener noreferrer nofollow" className="underline decoration-brand/40 hover:decoration-brand">
            {node}
          </a>
        ); break;
        default: break;
      }
    }
    nodes.push(<span key={`${start}-${end}`}>{node}</span>);
  }
  return nodes;
}

function Spoiler({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
      className={clsx('rounded px-0.5 transition', open ? '' : 'bg-ink/70 text-transparent select-none')}
      aria-label="Показать спойлер"
    >
      {children}
    </button>
  );
}

function VoicePlayer({ attachment }: { attachment: Attachment }) {
  const [playing, setPlaying] = useState(false);
  const peaks = attachment.waveform && attachment.waveform.length ? attachment.waveform : Array.from({ length: 32 }, () => 20 + Math.round(Math.random() * 60));
  const total = attachment.duration ?? 0;
  return (
    <div className="flex items-center gap-3 py-1">
      <button
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-white"
        onClick={(event) => {
          event.stopPropagation();
          setPlaying((value) => !value);
        }}
        aria-label={playing ? 'Пауза' : 'Воспроизвести'}
      >
        <Icon name={playing ? 'pause' : 'play'} size={16} filled={!playing} />
      </button>
      <div className="flex h-9 flex-1 items-center gap-[2px]">
        {peaks.slice(0, 40).map((peak, index) => (
          <span key={index} className="w-[3px] rounded-full bg-brand/60" style={{ height: `${Math.max(12, peak)}%` }} />
        ))}
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-ink-muted">
        {Math.floor(total / 60)}:{String(Math.floor(total % 60)).padStart(2, '0')}
      </span>
      {attachment.url ? <audio src={attachment.url} preload="none" onPlay={() => setPlaying(true)} onEnded={() => setPlaying(false)} className="hidden" /> : null}
    </div>
  );
}

function PollView({ message, onVote }: { message: Message; onVote?: (optionIds: string[]) => void }) {
  const poll = message.poll;
  if (!poll) return null;
  const [selected, setSelected] = useState<string[]>(poll.votedOptionIds);
  const total = poll.totalVotes || 1;
  return (
    <div className="min-w-[16rem] space-y-2 py-1">
      <div className="flex items-start gap-2">
        <Icon name="poll" size={16} className="mt-0.5 text-brand" />
        <div>
          <p className="text-sm font-semibold">{poll.question}</p>
          <p className="text-[11px] text-ink-muted">
            {poll.anonymous ? 'Анонимный опрос' : 'Открытый опрос'} · {poll.totalVotes} голосов{poll.closed ? ' · закрыт' : ''}
          </p>
        </div>
      </div>
      <div className="space-y-1.5">
        {poll.options.map((option) => {
          const voted = poll.votedOptionIds.includes(option.id);
          const percent = Math.round((option.votes / total) * 100);
          return (
            <button
              key={option.id}
              disabled={poll.closed}
              onClick={(event) => {
                event.stopPropagation();
                const next = poll.multiple
                  ? (selected.includes(option.id) ? selected.filter((id) => id !== option.id) : [...selected, option.id])
                  : [option.id];
                setSelected(next);
                onVote?.(next);
              }}
              className={clsx('relative w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-xs', voted ? 'border-brand' : 'border-line')}
            >
              <span className="absolute inset-y-0 left-0 bg-brand/15" style={{ width: `${percent}%` }} />
              <span className="relative flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  {voted ? <Icon name="check" size={13} className="text-brand" /> : null}
                  {option.text}
                </span>
                <span className="tabular-nums text-ink-muted">{percent}%</span>
              </span>
            </button>
          );
        })}
      </div>
      {!poll.closed && !poll.votedOptionIds.length ? (
        <button
          className="text-[11px] font-semibold text-brand"
          onClick={(event) => { event.stopPropagation(); onVote?.(selected); }}
        >
          Отправить голос
        </button>
      ) : null}
    </div>
  );
}

export function MessageContent({ message, onVote }: { message: Message; onVote?: (optionIds: string[]) => void }) {
  const attachments = message.attachments ?? [];
  const photos = attachments.filter((attachment) => attachment.kind === 'photo' || attachment.kind === 'gif');
  const others = attachments.filter((attachment) => attachment.kind !== 'photo' && attachment.kind !== 'gif');
  return (
    <div className="space-y-1.5">
      {message.forwardedFrom ? (
        <div className="flex items-center gap-1 text-[11px] font-medium text-brand">
          <Icon name="forward" size={12} />
          Переслано от {message.forwardedFrom.name}
        </div>
      ) : null}
      {message.replyTo ? (
        <div className="rounded-lg border-l-2 border-brand bg-black/5 px-2 py-1 text-[11px]">
          <div className="font-semibold text-brand">{message.replyTo.senderName ?? 'Сообщение'}</div>
          <div className="line-clamp-2 text-ink-muted">
            {message.replyTo.text || (message.replyTo.attachmentKind ? '📎 Вложение' : '')}
          </div>
        </div>
      ) : null}
      {photos.length ? (
        <div className={clsx('grid gap-1', photos.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
          {photos.map((photo) => (
            <a
              key={photo.id}
              href={photo.url ?? '#'}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="overflow-hidden rounded-lg"
            >
              <img
                src={photo.thumbUrl ?? photo.url ?? ''}
                alt={photo.fileName ?? 'Фото'}
                className={clsx('max-h-72 w-full object-cover', photo.spoiler && 'blur-2xl hover:blur-0')}
                loading="lazy"
              />
            </a>
          ))}
        </div>
      ) : null}
      {others.map((attachment) => (
        <div key={attachment.id} onClick={(event) => event.stopPropagation()}>
          {attachment.kind === 'voice' || attachment.kind === 'audio' ? (
            <VoicePlayer attachment={attachment} />
          ) : attachment.kind === 'video' || attachment.kind === 'video_note' ? (
            <video src={attachment.url ?? undefined} controls preload="metadata" className="max-h-72 w-full rounded-lg" />
          ) : attachment.kind === 'sticker' ? (
            <img src={attachment.url ?? ''} alt="Стикер" className="h-28 w-28 object-contain" />
          ) : attachment.kind === 'location' ? (
            <a
              className="flex items-center gap-2 rounded-lg bg-black/5 px-2 py-2 text-xs"
              href={`https://www.openstreetmap.org/?mlat=${attachment.latitude}&mlon=${attachment.longitude}#map=16/${attachment.latitude}/${attachment.longitude}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="globe" size={16} className="text-brand" />
              Геолокация {attachment.latitude?.toFixed(4)}, {attachment.longitude?.toFixed(4)}
            </a>
          ) : attachment.kind === 'contact' ? (
            <div className="flex items-center gap-2 rounded-lg bg-black/5 px-2 py-2 text-xs">
              <Icon name="user-plus" size={16} className="text-brand" />
              <span>
                <span className="block font-semibold">{attachment.contactName}</span>
                {attachment.contactUsername ? <span className="text-ink-muted">@{attachment.contactUsername}</span> : null}
              </span>
            </div>
          ) : (
            <a
              href={attachment.downloadUrl ?? undefined}
              className="flex items-center gap-2 rounded-lg bg-black/5 px-2 py-2 text-xs"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/15 text-brand"><Icon name="file" size={16} /></span>
              <span className="min-w-0">
                <span className="block truncate font-semibold">{attachment.fileName ?? 'Файл'}</span>
                <span className="text-ink-muted">{attachment.size ? formatBytes(attachment.size) : ''}</span>
              </span>
              <Icon name="download" size={16} className="ml-auto text-ink-faint" />
            </a>
          )}
        </div>
      ))}
      {message.poll ? <PollView message={message} onVote={onVote} /> : null}
      {message.text ? <p className="whitespace-pre-wrap break-words">{renderEntities(message.text, message.entities)}</p> : null}
    </div>
  );
}
