export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}

export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    return `${hours} ч ${mins % 60} мин`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatDateLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return 'Сегодня';
  if (date.toDateString() === yesterday.toDateString()) return 'Вчера';
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function lastSeenLabel(lastSeenAt: string | null, online: boolean): string {
  if (online) return 'в сети';
  if (!lastSeenAt) return 'был(а) недавно';
  const diff = Date.now() - new Date(lastSeenAt).getTime();
  if (diff < 60_000) return 'был(а) только что';
  if (diff < 3_600_000) return `был(а) ${Math.floor(diff / 60_000)} мин назад`;
  if (diff < 86_400_000) return `был(а) ${Math.floor(diff / 3_600_000)} ч назад`;
  return `был(а) ${new Date(lastSeenAt).toLocaleDateString('ru-RU')}`;
}
