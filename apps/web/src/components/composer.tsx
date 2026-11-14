import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { Attachment, ChatSummary, Message } from '@elian/shared';
import { Icon } from './icons';
import { Button, Spinner } from './ui';
import { api, uploadWithProgress } from '../lib/api';
import { useSendMessage, useTyping } from '../hooks/useElian';
import { useAppStore } from '../store/app';

const QUICK_EMOJI = ['👍', '❤️', '🔥', '😂', '🎉', '🙏', '👏', '😮', '😢', '💯', '✅', '👀'];

interface UploadingFile {
  id: string;
  name: string;
  progress: number;
  error?: string;
}

export function Composer({ chat, reply, edit }: { chat: ChatSummary; reply: Message | null; edit: Message | null }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploads, setUploads] = useState<UploadingFile[]>([]);
  const [showEmoji, setShowEmoji] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const setReply = useAppStore((state) => state.setComposerReply);
  const setEdit = useAppStore((state) => state.setComposerEdit);
  const toast = useAppStore((state) => state.toast);
  const send = useSendMessage(chat.id);
  const typing = useTyping(chat.id);

  const canSend = Boolean(chat.permissions?.sendMessages) || chat.role === 'owner' || chat.role === 'admin';
  const readOnly = chat.type === 'channel' && chat.role === 'member';

  useEffect(() => {
    if (edit) {
      setText(edit.text);
      textareaRef.current?.focus();
    }
  }, [edit]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setRecordSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [text]);

  async function submit() {
    const trimmed = text.trim();
    if (edit) {
      try {
        await api.patch(`/messages/${edit.id}`, { text: trimmed });
        setEdit(null);
        setText('');
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Ошибка', 'error');
      }
      return;
    }
    if (!trimmed && !attachments.length) return;
    const pendingAttachments = attachments;
    setText('');
    setAttachments([]);
    setReply(null);
    await send.mutateAsync({ text: trimmed, replyToId: reply?.id ?? null, attachments: pendingAttachments });
    typing('stop');
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      const id = crypto.randomUUID();
      setUploads((current) => [...current, { id, name: file.name, progress: 0 }]);
      const formData = new FormData();
      const kind = file.type.startsWith('image/') ? 'photo' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'file';
      formData.append('file', file);
      formData.append('kind', kind);
      try {
        const result = await uploadWithProgress<{ media: { id: string; kind: string; mimeType: string; size: number; fileName: string; url: string; thumbUrl: string; downloadUrl: string } }>(
          '/media/upload',
          formData,
          (progress) => setUploads((current) => current.map((item) => (item.id === id ? { ...item, progress } : item))),
        );
        const media = result.media;
        setAttachments((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            kind: media.kind as Attachment['kind'],
            mediaId: media.id,
            fileName: media.fileName,
            mimeType: media.mimeType,
            size: media.size,
            width: null,
            height: null,
            duration: null,
            waveform: null,
            thumbnailMediaId: null,
            spoiler: false,
            url: media.url,
            thumbUrl: media.thumbUrl,
            downloadUrl: media.downloadUrl,
          },
        ]);
        setUploads((current) => current.filter((item) => item.id !== id));
      } catch (error) {
        setUploads((current) => current.map((item) => (item.id === id ? { ...item, error: (error as Error).message } : item)));
        toast((error as Error).message, 'error');
      }
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => chunksRef.current.push(event.data);
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        stream.getTracks().forEach((track) => track.stop());
        const seconds = recordSeconds;
        setRecordSeconds(0);
        if (blob.size < 800) {
          toast('Запись слишком короткая', 'error');
          return;
        }
        const formData = new FormData();
        formData.append('file', blob, 'voice.webm');
        formData.append('kind', 'voice');
        formData.append('duration', String(seconds));
        try {
          const result = await uploadWithProgress<{ media: { id: string; url: string; downloadUrl: string; size: number } }>('/media/upload', formData);
          await send.mutateAsync({
            text: '',
            replyToId: reply?.id ?? null,
            attachments: [{
              id: crypto.randomUUID(),
              kind: 'voice',
              mediaId: result.media.id,
              fileName: 'voice.webm',
              mimeType: 'audio/webm',
              size: result.media.size,
              width: null, height: null, duration: seconds,
              waveform: Array.from({ length: 40 }, () => 15 + Math.round(Math.random() * 85)),
              thumbnailMediaId: null, spoiler: false,
              url: result.media.url, thumbUrl: null, downloadUrl: result.media.downloadUrl,
            }],
          });
        } catch (error) {
          toast((error as Error).message, 'error');
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      setRecordSeconds(0);
      typing('voice');
    } catch {
      toast('Микрофон недоступен. Разрешите доступ в настройках браузера.', 'error');
    }
  }

  function stopRecording(cancel = false) {
    const recorder = recorderRef.current;
    if (!recorder) return;
    setRecording(false);
    if (cancel) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
    }
    recorder.stop();
    recorderRef.current = null;
  }

  if (readOnly) {
    return (
      <div className="safe-bottom border-t border-line bg-surface-raised px-4 py-3 text-center text-xs text-ink-muted">
        Канал: писать могут только администраторы
      </div>
    );
  }

  return (
    <div className="safe-bottom border-t border-line bg-surface-raised">
      {reply || edit ? (
        <div className="flex items-start gap-2 border-b border-line px-3 py-2 text-xs">
          <Icon name={edit ? 'edit' : 'reply'} size={15} className="mt-0.5 text-brand" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-brand">{edit ? 'Редактирование' : `Ответ ${reply?.sender?.displayName ?? ''}`}</div>
            <div className="truncate text-ink-muted">{edit ? edit.text : reply?.text ?? 'Вложение'}</div>
          </div>
          <button className="icon-btn !h-7 !w-7" onClick={() => { setReply(null); setEdit(null); if (edit) setText(''); }} aria-label="Отменить">
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : null}

      {attachments.length || uploads.length ? (
        <div className="flex flex-wrap gap-2 border-b border-line px-3 py-2">
          {attachments.map((attachment) => (
            <span key={attachment.id} className="chip bg-surface-hover text-ink">
              <Icon name={attachment.kind === 'photo' ? 'image' : 'file'} size={13} />
              {attachment.fileName ?? attachment.kind}
              <button onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} aria-label="Убрать">
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
          {uploads.map((upload) => (
            <span key={upload.id} className="chip bg-surface-hover text-ink-muted">
              <Spinner size={12} />
              {upload.name} · {upload.progress}%
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex items-end gap-1.5 px-2 py-2">
        <input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => uploadFiles(event.target.files)} />
        <button className="icon-btn" onClick={() => fileRef.current?.click()} aria-label="Прикрепить файл" disabled={!canSend}>
          <Icon name="paperclip" />
        </button>
        <button className="icon-btn hidden sm:inline-flex" onClick={() => setShowEmoji((value) => !value)} aria-label="Эмодзи">
          <Icon name="smile" />
        </button>
        <div className="relative flex-1">
          {showEmoji ? (
            <div className="absolute bottom-12 left-0 z-10 grid w-60 grid-cols-6 gap-1 rounded-xl2 border border-line bg-surface p-2 shadow-xl animate-pop-in">
              {QUICK_EMOJI.map((emoji) => (
                <button
                  key={emoji}
                  className="rounded-lg p-1.5 text-lg hover:bg-surface-hover"
                  onClick={() => { setText((value) => value + emoji); setShowEmoji(false); textareaRef.current?.focus(); }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            onChange={(event) => { setText(event.target.value); typing('typing'); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={recording ? 'Идёт запись…' : 'Написать сообщение…'}
            className="max-h-40 w-full resize-none rounded-xl2 border border-line bg-surface px-3.5 py-2.5 text-sm outline-none focus:border-brand"
            disabled={recording || !canSend}
            aria-label="Сообщение"
          />
        </div>
        {recording ? (
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-danger tabular-nums">
              ● {Math.floor(recordSeconds / 60)}:{String(recordSeconds % 60).padStart(2, '0')}
            </span>
            <button className="icon-btn text-danger" onClick={() => stopRecording(true)} aria-label="Отменить запись"><Icon name="trash" /></button>
            <button className="btn-primary !px-3" onClick={() => stopRecording(false)} aria-label="Отправить голосовое"><Icon name="send" size={16} /></button>
          </div>
        ) : text.trim() || attachments.length || edit ? (
          <button className="btn-primary !px-3.5" onClick={() => void submit()} aria-label="Отправить" disabled={send.isPending}>
            {send.isPending ? <Spinner size={16} /> : <Icon name="send" size={16} />}
          </button>
        ) : (
          <button className="icon-btn" onClick={() => void startRecording()} aria-label="Голосовое сообщение" disabled={!canSend}>
            <Icon name="mic" />
          </button>
        )}
      </div>
      {!canSend ? <p className="px-4 pb-2 text-[11px] text-ink-faint">Отправка сообщений ограничена администратором чата.</p> : null}
    </div>
  );
}

export { Button };
