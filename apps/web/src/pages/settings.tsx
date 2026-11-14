import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Folder, PublicUser, SessionInfo, SelfUser } from '@elian/shared';
import { api, ApiError, uploadWithProgress } from '../lib/api';
import { clearCache } from '../lib/db';
import { useAppStore } from '../store/app';
import { useI18nStore, type Locale } from '../lib/i18n';
import { useBlocked, useContacts, useSessions } from '../hooks/useElian';
import { Avatar, Badge, Button, Input, Modal, Row, SectionCard, Select, Switch, Textarea } from '../components/ui';
import { Icon } from '../components/icons';
import { formatBytes } from '../components/format';

interface UserSettings {
  privacy: {
    lastSeen: 'everybody' | 'contacts' | 'nobody';
    profilePhoto: 'everybody' | 'contacts' | 'nobody';
    calls: 'everybody' | 'contacts' | 'nobody';
    phone: 'everybody' | 'contacts' | 'nobody';
    forwarding: boolean;
    groupInvites: 'everybody' | 'contacts' | 'nobody';
    searchByUsername: boolean;
    readReceipts: boolean;
    stories: 'everybody' | 'contacts' | 'close_friends';
    closeFriends: string[];
  };
  notifications: { private: boolean; groups: boolean; channels: boolean; sound: boolean; vibration: boolean; preview: boolean; mentionsOnly: boolean };
  appearance: { theme: 'light' | 'dark' | 'system'; accent: string; textSize: number; compact: boolean; animations: boolean; wallpaper: string | null };
  chats: { sendOnEnter: boolean; drafts: boolean; autoDownload: 'always' | 'wifi' | 'never'; defaultReactions: string[] };
  business: { enabled: boolean; greeting: string | null; away: string | null; quickReplies: string[]; hours: unknown };
  language: 'ru' | 'en';
  showPhone: boolean;
  experimental: Record<string, boolean>;
}

const SECTIONS = [
  { id: 'profile', label: 'Профиль', icon: 'users' },
  { id: 'privacy', label: 'Приватность', icon: 'lock' },
  { id: 'security', label: 'Безопасность', icon: 'shield' },
  { id: 'notifications', label: 'Уведомления', icon: 'bell' },
  { id: 'appearance', label: 'Оформление', icon: 'palette' },
  { id: 'chats', label: 'Чаты и папки', icon: 'folder' },
  { id: 'devices', label: 'Устройства', icon: 'devices' },
  { id: 'data', label: 'Данные и память', icon: 'database' },
  { id: 'language', label: 'Язык', icon: 'globe' },
  { id: 'advanced', label: 'Дополнительно', icon: 'sliders' },
] as const;

export function SettingsPage() {
  const me = useAppStore((state) => state.user);
  const setUser = useAppStore((state) => state.setUser);
  const toast = useAppStore((state) => state.toast);
  const logout = useAppStore((state) => state.logout);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [section, setSection] = useState<(typeof SECTIONS)[number]['id']>('profile');
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: UserSettings }>('/me/settings').then((result) => result.settings),
  });
  const settings = settingsQuery.data;

  async function patchSettings(patch: Partial<UserSettings>) {
    try {
      const result = await api.patch<{ settings: UserSettings }>('/me/settings', patch);
      queryClient.setQueryData(['settings'], result.settings);
      if (patch.language) useI18nStore.getState().setLocale(patch.language as Locale);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  if (!me || !settings) {
    return <div className="p-6 text-sm text-ink-muted">Загрузка настроек…</div>;
  }

  return (
    <div className="flex h-full min-h-0">
      <nav className="hidden w-56 shrink-0 border-r border-line p-2 md:block">
        <Link to="/" className="mb-3 flex items-center gap-2 rounded-xl2 px-2 py-2 text-sm font-medium hover:bg-surface-hover">
          <Icon name="arrow-left" size={16} /> К чатам
        </Link>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            onClick={() => setSection(item.id)}
            className={`flex w-full items-center gap-2.5 rounded-xl2 px-2.5 py-2 text-left text-sm ${section === item.id ? 'bg-brand-soft text-brand' : 'hover:bg-surface-hover'}`}
          >
            <Icon name={item.icon} size={17} /> {item.label}
          </button>
        ))}
        <button
          className="mt-3 flex w-full items-center gap-2.5 rounded-xl2 px-2.5 py-2 text-left text-sm text-danger hover:bg-surface-hover"
          onClick={async () => {
            await api.post('/auth/logout').catch(() => undefined);
            logout();
            navigate('/login');
          }}
        >
          <Icon name="logout" size={17} /> Выйти
        </button>
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto p-4 pb-20">
        <div className="mb-3 flex gap-1.5 overflow-x-auto md:hidden">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              className={`chip whitespace-nowrap ${section === item.id ? 'bg-brand text-white' : 'bg-surface-hover text-ink-muted'}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {section === 'profile' ? (
          <ProfileSection user={me} onSaved={(user) => setUser(user)} onReload={() => void queryClient.invalidateQueries({ queryKey: ['me'] })} />
        ) : null}

        {section === 'privacy' ? (
          <SectionCard title="Приватность" description="Кто видит ваши данные и может вам писать" icon="lock">
            <Row label="Последняя активность"><Select value={settings.privacy.lastSeen} onChange={(value) => patchSettings({ privacy: { ...settings.privacy, lastSeen: value as 'everybody' } })} options={AUDIENCE} /></Row>
            <Row label="Фото профиля"><Select value={settings.privacy.profilePhoto} onChange={(value) => patchSettings({ privacy: { ...settings.privacy, profilePhoto: value as 'everybody' } })} options={AUDIENCE} /></Row>
            <Row label="Звонки"><Select value={settings.privacy.calls} onChange={(value) => patchSettings({ privacy: { ...settings.privacy, calls: value as 'everybody' } })} options={AUDIENCE} /></Row>
            <Row label="Номер телефона"><Select value={settings.privacy.phone} onChange={(value) => patchSettings({ privacy: { ...settings.privacy, phone: value as 'everybody' } })} options={AUDIENCE} /></Row>
            <Row label="Приглашения в группы"><Select value={settings.privacy.groupInvites} onChange={(value) => patchSettings({ privacy: { ...settings.privacy, groupInvites: value as 'everybody' } })} options={AUDIENCE} /></Row>
            <Row label="Истории видят"><Select value={settings.privacy.stories} onChange={(value) => patchSettings({ privacy: { ...settings.privacy, stories: value as 'everybody' } })} options={[{ value: 'everybody', label: 'Все' }, { value: 'contacts', label: 'Контакты' }, { value: 'close_friends', label: 'Близкие друзья' }]} /></Row>
            <Row label="Пересылка сообщений" description="Ссылка на профиль при пересылке"><Switch checked={settings.privacy.forwarding} onChange={(value) => patchSettings({ privacy: { ...settings.privacy, forwarding: value } })} label="" /></Row>
            <Row label="Поиск по @username"><Switch checked={settings.privacy.searchByUsername} onChange={(value) => patchSettings({ privacy: { ...settings.privacy, searchByUsername: value } })} label="" /></Row>
            <Row label="Отчёты о прочтении"><Switch checked={settings.privacy.readReceipts} onChange={(value) => patchSettings({ privacy: { ...settings.privacy, readReceipts: value } })} label="" /></Row>
          </SectionCard>
        ) : null}

        {section === 'security' ? <SecuritySection user={me} /> : null}

        {section === 'notifications' ? (
          <NotificationSection settings={settings} onChange={patchSettings} />
        ) : null}

        {section === 'appearance' ? <AppearanceSection settings={settings} onChange={patchSettings} /> : null}

        {section === 'chats' ? <ChatsSection settings={settings} onChange={patchSettings} /> : null}

        {section === 'devices' ? <DevicesSection /> : null}

        {section === 'data' ? <DataSection me={me} /> : null}

        {section === 'language' ? (
          <SectionCard title="Язык" description="Интерфейс и системные уведомления" icon="globe">
            <Row label="Язык интерфейса">
              <Select
                value={settings.language}
                onChange={(value) => {
                  void patchSettings({ language: value as 'ru' | 'en' });
                }}
                options={[{ value: 'ru', label: 'Русский' }, { value: 'en', label: 'English' }]}
              />
            </Row>
            <p className="px-1 text-xs text-ink-faint">Переводы интерфейса применяются сразу; часть системных сообщений сервера остаётся на русском.</p>
          </SectionCard>
        ) : null}

        {section === 'advanced' ? <AdvancedSection settings={settings} onChange={patchSettings} onLogoutAll={() => { logout(); navigate('/login'); }} /> : null}
      </div>
    </div>
  );
}

const AUDIENCE = [
  { value: 'everybody', label: 'Все' },
  { value: 'contacts', label: 'Мои контакты' },
  { value: 'nobody', label: 'Никто' },
];

function ProfileSection({ user, onSaved, onReload }: { user: SelfUser; onSaved: (user: SelfUser) => void; onReload: () => void }) {
  const toast = useAppStore((state) => state.toast);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio ?? '');
  const [username, setUsername] = useState(user.username);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-4">
      <SectionCard title="Профиль" description="Как вас видят другие" icon="users">
        <div className="flex items-center gap-3 px-1 py-2">
          <Avatar name={user.displayName} src={user.avatarUrl} size={64} />
          <div>
            <Button size="sm" variant="soft" icon="camera" onClick={() => fileRef.current?.click()}>Сменить фото</Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const form = new FormData();
                form.append('file', file);
                try {
                  const result = await uploadWithProgress<{ user: SelfUser }>('/me/avatar', form);
                  onSaved(result.user);
                  toast('Фото обновлено', 'success');
                } catch (error) {
                  toast((error as Error).message, 'error');
                }
              }}
            />
            <p className="mt-1 text-[11px] text-ink-faint">JPEG/PNG/WebP до 8 МБ. Хранится зашифрованным на сервере.</p>
          </div>
        </div>
        <div className="space-y-3 px-1 py-2">
          <Input label="Имя" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={64} />
          <Textarea label="О себе" value={bio} onChange={(event) => setBio(event.target.value)} maxLength={256} />
          <div className="flex items-end gap-2">
            <Input label="Username" value={username} onChange={(event) => setUsername(event.target.value)} className="flex-1" />
            <Button
              variant="soft"
              disabled={username === user.username}
              onClick={async () => {
                try {
                  const result = await api.post<{ user: SelfUser }>('/me/username', { username });
                  onSaved(result.user);
                  toast('Username обновлён', 'success');
                } catch (error) {
                  toast((error as Error).message, 'error');
                }
              }}
            >
              Сменить
            </Button>
          </div>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await api.patch<{ user: SelfUser }>('/me', { displayName, bio });
                onSaved(result.user);
                onReload();
                toast('Профиль сохранён', 'success');
              } catch (error) {
                toast((error as Error).message, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            Сохранить
          </Button>
        </div>
      </SectionCard>
      <SectionCard title="Публичная ссылка" icon="qr">
        <div className="flex items-center justify-between gap-2 px-1 py-2">
          <code className="truncate rounded-lg bg-surface-hover px-2 py-1 text-xs">{`${window.location.origin}/u/${user.username}`}</code>
          <Button size="sm" variant="soft" onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}/u/${user.username}`); toast('Ссылка скопирована', 'success'); }}>
            Копировать
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}

function SecuritySection({ user }: { user: SelfUser }) {
  const toast = useAppStore((state) => state.toast);
  const queryClient = useQueryClient();
  const sessions = useSessions();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [tfaSetup, setTfaSetup] = useState<{ secretBase32: string; otpauthUrl: string; secretHex: string } | null>(null);
  const [code, setCode] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-4">
      <SectionCard title="Пароль" description="Смена завершит все другие сессии" icon="lock">
        <div className="px-1 py-2">
          <Button variant="soft" onClick={() => setPasswordOpen(true)}>Изменить пароль</Button>
        </div>
      </SectionCard>

      <SectionCard title="Двухфакторная аутентификация" description="TOTP-приложение (Aegis, Google Authenticator)" icon="shield">
        <div className="space-y-2 px-1 py-2">
          {user.tfaEnabled ? (
            <>
              <Badge tone="success">Включена</Badge>
              <TfaDisable onDone={async () => { await queryClient.invalidateQueries({ queryKey: ['me'] }); toast('2FA отключена', 'success'); }} />
            </>
          ) : tfaSetup ? (
            <div className="space-y-2">
              <p className="text-xs text-ink-muted">Добавьте секрет в приложение и введите код:</p>
              <code className="block break-all rounded-lg bg-surface-hover p-2 text-xs">{tfaSetup.secretBase32}</code>
              <Input label="Код из приложения" value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" />
              <Button
                onClick={async () => {
                  try {
                    await api.post('/me/tfa/enable', { secretHex: tfaSetup.secretHex, code });
                    await queryClient.invalidateQueries({ queryKey: ['me'] });
                    setTfaSetup(null);
                    setCode('');
                    toast('2FA включена', 'success');
                  } catch (error) {
                    toast((error as Error).message, 'error');
                  }
                }}
              >
                Включить
              </Button>
            </div>
          ) : (
            <Button
              variant="soft"
              onClick={async () => {
                try {
                  const result = await api.post<{ secretBase32: string; otpauthUrl: string; secretHex: string }>('/me/tfa/setup');
                  setTfaSetup(result);
                } catch (error) {
                  toast((error as Error).message, 'error');
                }
              }}
            >
              Настроить 2FA
            </Button>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Активные сессии" description="Устройства, где выполнен вход" icon="devices">
        <div className="divide-y divide-line">
          {(sessions.data ?? []).map((session: SessionInfo) => (
            <div key={session.id} className="flex items-center gap-2 px-1 py-2 text-sm">
              <Icon name={/android|ios|mobile/i.test(session.device) ? 'phone' : 'monitor'} size={16} className="text-ink-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{session.device} {session.current ? <Badge tone="success">это устройство</Badge> : null}</div>
                <div className="text-[11px] text-ink-muted">
                  {session.ipMasked ?? 'IP скрыт'} · активность {new Date(session.lastActiveAt).toLocaleString('ru-RU')}
                </div>
              </div>
              {!session.current ? (
                <Button size="sm" variant="ghost" onClick={async () => {
                  await api.del(`/me/sessions/${session.id}`).catch(() => undefined);
                  await sessions.refetch();
                  toast('Сессия завершена', 'success');
                }}>Завершить</Button>
              ) : null}
            </div>
          ))}
        </div>
        <div className="px-1 py-2">
          <Button variant="ghost" onClick={async () => {
            await api.del('/me/sessions').catch(() => undefined);
            await sessions.refetch();
            toast('Другие сессии завершены', 'success');
          }}>Завершить все другие сессии</Button>
        </div>
      </SectionCard>

      <Modal
        open={passwordOpen}
        onClose={() => setPasswordOpen(false)}
        title="Смена пароля"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPasswordOpen(false)}>Отмена</Button>
            <Button
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.post('/me/password', { currentPassword: current, newPassword: next });
                  toast('Пароль изменён', 'success');
                  setPasswordOpen(false);
                  setCurrent('');
                  setNext('');
                  await sessions.refetch();
                } catch (error) {
                  toast(error instanceof ApiError ? error.message : 'Не удалось изменить пароль', 'error');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Сохранить
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Input label="Текущий пароль" type="password" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" />
          <Input label="Новый пароль" type="password" value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" hint="Минимум 10 символов, не из списка популярных" />
        </div>
      </Modal>
    </div>
  );
}

function TfaDisable({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const toast = useAppStore((state) => state.toast);
  return (
    <div className="space-y-2">
      <Input label="Пароль для отключения" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
      <Button
        variant="ghost"
        onClick={async () => {
          try {
            await api.post('/me/tfa/disable', { password });
            setPassword('');
            onDone();
          } catch (error) {
            toast((error as Error).message, 'error');
          }
        }}
      >
        Отключить 2FA
      </Button>
    </div>
  );
}

function NotificationSection({ settings, onChange }: { settings: UserSettings; onChange: (patch: Partial<UserSettings>) => void }) {
  const toast = useAppStore((state) => state.toast);
  const [pushState, setPushState] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const n = settings.notifications;
  return (
    <div className="space-y-4">
      <SectionCard title="Push-уведомления" description="Работают в установленной PWA (Android/Desktop)" icon="bell">
        <div className="space-y-2 px-1 py-2">
          <p className="text-xs text-ink-muted">
            {pushState === 'granted' ? 'Разрешение выдано.' : pushState === 'denied' ? 'Уведомления заблокированы в браузере.' : pushState === 'unsupported' ? 'Браузер не поддерживает push.' : 'Разрешение не запрошено.'}
          </p>
          <div className="flex gap-2">
            <Button
              variant="soft"
              onClick={async () => {
                try {
                  const permission = await Notification.requestPermission();
                  setPushState(permission);
                  if (permission !== 'granted') return;
                  const { publicKey } = await api.get<{ publicKey: string | null }>('/push/public-key');
                  if (!publicKey) throw new Error('VAPID-ключ не настроен на сервере');
                  const registration = await navigator.serviceWorker.ready;
                  const subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
                  });
                  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
                  await api.post('/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
                  toast('Push включены', 'success');
                } catch (error) {
                  toast((error as Error).message, 'error');
                }
              }}
            >
              Включить push
            </Button>
            <Button variant="ghost" onClick={async () => {
              try {
                const result = await api.post<{ sent?: number }>('/push/test');
                toast(`Тестовое уведомление: ${result.sent ?? 0}`, 'info');
              } catch (error) {
                toast((error as Error).message, 'error');
              }
            }}>Тест</Button>
          </div>
        </div>
      </SectionCard>
      <SectionCard title="Что уведомлять" icon="bell">
        <Row label="Личные сообщения"><Switch label="" checked={n.private} onChange={(value) => onChange({ notifications: { ...n, private: value } })} /></Row>
        <Row label="Группы"><Switch label="" checked={n.groups} onChange={(value) => onChange({ notifications: { ...n, groups: value } })} /></Row>
        <Row label="Каналы"><Switch label="" checked={n.channels} onChange={(value) => onChange({ notifications: { ...n, channels: value } })} /></Row>
        <Row label="Только упоминания"><Switch label="" checked={n.mentionsOnly} onChange={(value) => onChange({ notifications: { ...n, mentionsOnly: value } })} /></Row>
        <Row label="Звук"><Switch label="" checked={n.sound} onChange={(value) => onChange({ notifications: { ...n, sound: value } })} /></Row>
        <Row label="Вибрация"><Switch label="" checked={n.vibration} onChange={(value) => onChange({ notifications: { ...n, vibration: value } })} /></Row>
        <Row label="Показывать текст" description="На экране блокировки текст может быть виден посторонним"><Switch label="" checked={n.preview} onChange={(value) => onChange({ notifications: { ...n, preview: value } })} /></Row>
      </SectionCard>
    </div>
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

function AppearanceSection({ settings, onChange }: { settings: UserSettings; onChange: (patch: Partial<UserSettings>) => void }) {
  const store = useAppStore();
  const accents = ['#4B3AF0', '#2563EB', '#0F766E', '#B91C1C', '#7C3AED', '#DB2777', '#EA580C'];
  return (
    <SectionCard title="Оформление" icon="palette">
      <Row label="Тема">
        <Select
          value={store.theme}
          onChange={(value) => {
            store.setTheme(value as 'light');
            void onChange({ appearance: { ...settings.appearance, theme: value as 'light' } });
          }}
          options={[{ value: 'system', label: 'Как в системе' }, { value: 'light', label: 'Светлая' }, { value: 'dark', label: 'Тёмная' }]}
        />
      </Row>
      <Row label="Акцентный цвет">
        <div className="flex gap-1.5">
          {accents.map((color) => (
            <button
              key={color}
              aria-label={`Акцент ${color}`}
              onClick={() => { store.setAccent(color); void onChange({ appearance: { ...settings.appearance, accent: color } }); }}
              className={`h-7 w-7 rounded-full border-2 ${store.accent === color ? 'border-ink' : 'border-transparent'}`}
              style={{ background: color }}
            />
          ))}
        </div>
      </Row>
      <Row label="Размер текста">
        <Select
          value={store.textSize}
          onChange={(value) => { store.setTextSize(value as 'normal'); void onChange({ appearance: { ...settings.appearance, textSize: 16 } }); }}
          options={[{ value: 'compact', label: 'Компактный' }, { value: 'normal', label: 'Обычный' }, { value: 'large', label: 'Крупный' }, { value: 'xlarge', label: 'Очень крупный' }]}
        />
      </Row>
      <Row label="Компактные чаты"><Switch label="" checked={store.compactMode} onChange={(value) => { store.setCompactMode(value); void onChange({ appearance: { ...settings.appearance, compact: value } }); }} /></Row>
      <Row label="Анимации"><Switch label="" checked={!store.reducedMotion} onChange={(value) => { store.setReducedMotion(!value); void onChange({ appearance: { ...settings.appearance, animations: value } }); }} /></Row>
    </SectionCard>
  );
}

function ChatsSection({ settings, onChange }: { settings: UserSettings; onChange: (patch: Partial<UserSettings>) => void }) {
  const toast = useAppStore((state) => state.toast);
  const queryClient = useQueryClient();
  const foldersQuery = useQuery({ queryKey: ['folders'], queryFn: () => api.get<{ folders: Folder[] }>('/folders').then((result) => result.folders) });
  const blocked = useBlocked();
  const contacts = useContacts();
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderMode, setFolderMode] = useState<'all' | 'unread' | 'groups' | 'channels'>('unread');

  return (
    <div className="space-y-4">
      <SectionCard title="Поведение чатов" icon="folder">
        <Row label="Отправка по Enter" description="Shift+Enter — новая строка"><Switch label="" checked={settings.chats.sendOnEnter} onChange={(value) => onChange({ chats: { ...settings.chats, sendOnEnter: value } })} /></Row>
        <Row label="Синхронизировать черновики"><Switch label="" checked={settings.chats.drafts} onChange={(value) => onChange({ chats: { ...settings.chats, drafts: value } })} /></Row>
        <Row label="Автозагрузка медиа">
          <Select
            value={settings.chats.autoDownload}
            onChange={(value) => onChange({ chats: { ...settings.chats, autoDownload: value as 'always' } })}
            options={[{ value: 'always', label: 'Всегда' }, { value: 'wifi', label: 'Только Wi-Fi' }, { value: 'never', label: 'Никогда' }]}
          />
        </Row>
      </SectionCard>

      <SectionCard title="Папки с чатами" icon="folder" description="Быстрые фильтры над списком чатов">
        <div className="space-y-1 px-1 py-1">
          {(foldersQuery.data ?? []).map((folder) => (
            <div key={folder.id} className="flex items-center gap-2 text-sm">
              <span className="flex-1 truncate">{folder.emoji ?? '📁'} {folder.name}</span>
              <Button size="sm" variant="ghost" onClick={async () => {
                await api.del(`/folders/${folder.id}`).catch(() => undefined);
                await foldersQuery.refetch();
                await queryClient.invalidateQueries({ queryKey: ['folders'] });
              }}>Удалить</Button>
            </div>
          ))}
          {!foldersQuery.data?.length ? <p className="text-xs text-ink-faint">Пока нет папок</p> : null}
        </div>
        <div className="px-1 py-2">
          <Button size="sm" variant="soft" icon="plus" onClick={() => setFolderOpen(true)}>Новая папка</Button>
        </div>
      </SectionCard>

      <SectionCard title="Контакты" icon="users" description={`${contacts.data?.length ?? 0} контактов`}>
        <div className="max-h-52 space-y-0.5 overflow-y-auto">
          {(contacts.data ?? []).map((user: PublicUser) => (
            <div key={user.id} className="flex items-center gap-2 px-1 py-1.5 text-sm">
              <Avatar name={user.displayName} src={user.avatarUrl} size={28} seed={user.id} />
              <span className="min-w-0 flex-1 truncate">{user.displayName} <span className="text-xs text-ink-muted">@{user.username}</span></span>
              <Button size="sm" variant="ghost" onClick={async () => { await api.del(`/contacts/${user.id}`).catch(() => undefined); await contacts.refetch(); }}>Удалить</Button>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Заблокированные" icon="ban">
        <div className="space-y-0.5">
          {(blocked.data ?? []).map((user: PublicUser) => (
            <div key={user.id} className="flex items-center gap-2 px-1 py-1.5 text-sm">
              <Avatar name={user.displayName} src={user.avatarUrl} size={28} seed={user.id} />
              <span className="min-w-0 flex-1 truncate">{user.displayName}</span>
              <Button size="sm" variant="ghost" onClick={async () => { await api.del(`/blocks/${user.id}`).catch(() => undefined); await blocked.refetch(); toast('Разблокирован', 'success'); }}>Разблокировать</Button>
            </div>
          ))}
          {!blocked.data?.length ? <p className="px-1 text-xs text-ink-faint">Никого не заблокировали</p> : null}
        </div>
      </SectionCard>

      <Modal
        open={folderOpen}
        onClose={() => setFolderOpen(false)}
        title="Новая папка"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setFolderOpen(false)}>Отмена</Button>
            <Button
              onClick={async () => {
                try {
                  const rules = folderMode === 'all' ? [] : folderMode === 'unread'
                    ? [{ type: 'unread' as const, include: true }]
                    : [{ type: 'type' as const, value: folderMode === 'groups' ? 'group' : 'channel', include: true }];
                  await api.post('/folders', { name: folderName, emoji: '📁', rules, includedChatIds: [], excludedChatIds: [], unreadOnly: folderMode === 'unread' });
                  setFolderOpen(false);
                  setFolderName('');
                  await foldersQuery.refetch();
                  await queryClient.invalidateQueries({ queryKey: ['folders'] });
                  toast('Папка создана', 'success');
                } catch (error) {
                  toast((error as Error).message, 'error');
                }
              }}
            >
              Создать
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Input label="Название" value={folderName} onChange={(event) => setFolderName(event.target.value)} maxLength={32} />
          <Row label="Включать">
            <Select
              value={folderMode}
              onChange={(value) => setFolderMode(value as 'all')}
              options={[{ value: 'all', label: 'Все чаты' }, { value: 'unread', label: 'Непрочитанные' }, { value: 'groups', label: 'Группы' }, { value: 'channels', label: 'Каналы' }]}
            />
          </Row>
        </div>
      </Modal>
    </div>
  );
}

function DevicesSection() {
  const sessions = useSessions();
  const toast = useAppStore((state) => state.toast);
  const installPrompt = useAppStore((state) => state.installPrompt);
  return (
    <div className="space-y-4">
      <SectionCard title="Установка приложения" description="PWA: работает офлайн-очередью и получает push" icon="devices">
        <div className="px-1 py-2">
          {installPrompt ? (
            <Button
              onClick={async () => {
                const event = (window as unknown as { __elianInstall?: { prompt: () => Promise<void> } }).__elianInstall;
                await event?.prompt();
              }}
            >
              Установить Элиан
            </Button>
          ) : (
            <p className="text-xs text-ink-muted">Откройте меню браузера → «Установить приложение» / «На главный экран».</p>
          )}
        </div>
      </SectionCard>
      <SectionCard title="Сессии" icon="devices">
        <div className="divide-y divide-line">
          {(sessions.data ?? []).map((session) => (
            <div key={session.id} className="flex items-center gap-2 px-1 py-2 text-sm">
              <Icon name="monitor" size={16} className="text-ink-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{session.device}{session.current ? ' · это устройство' : ''}</div>
                <div className="text-[11px] text-ink-muted">{session.platform ?? 'браузер'} · {new Date(session.lastActiveAt).toLocaleString('ru-RU')}</div>
              </div>
              {!session.current ? (
                <Button size="sm" variant="ghost" onClick={async () => { await api.del(`/me/sessions/${session.id}`).catch(() => undefined); await sessions.refetch(); toast('Сессия завершена', 'success'); }}>Выйти</Button>
              ) : null}
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

function DataSection({ me }: { me: SelfUser }) {
  const toast = useAppStore((state) => state.toast);
  const logout = useAppStore((state) => state.logout);
  const navigate = useNavigate();
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [usage, setUsage] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        setUsage(estimate.usage ?? 0);
      }
    })();
  }, []);

  return (
    <div className="space-y-4">
      <SectionCard title="Память устройства" icon="database">
        <Row label="Кэш PWA и медиа">{usage !== null ? formatBytes(usage) : '—'}</Row>
        <div className="flex gap-2 px-1 py-2">
          <Button variant="ghost" onClick={async () => {
            await clearCache();
            if (navigator.storage?.estimate) {
              const estimate = await navigator.storage.estimate();
              setUsage(estimate.usage ?? 0);
            }
            toast('Локальный кэш очищен', 'success');
          }}>Очистить кэш</Button>
        </div>
      </SectionCard>

      <SectionCard title="Экспорт данных" icon="download" description="JSON с профилем и вашими сообщениями">
        <div className="px-1 py-2">
          <a className="btn-soft inline-flex" href="/api/v1/me/export">Скачать архив</a>
        </div>
      </SectionCard>

      <SectionCard title="Диагностика" icon="info">
        <div className="px-1 py-2">
          <Button variant="soft" onClick={async () => {
            const result = await api.get<Record<string, unknown>>('/me/diagnostics');
            setDiagnostics(result);
          }}>Показать</Button>
          {diagnostics ? <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-hover p-2 text-[11px]">{JSON.stringify(diagnostics, null, 2)}</pre> : null}
        </div>
      </SectionCard>

      <SectionCard title="Удаление аккаунта" description="Необратимо: профиль анонимизируется, сессии завершаются" icon="trash">
        <div className="px-1 py-2">
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>Удалить аккаунт @{me.username}</Button>
        </div>
      </SectionCard>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Удалить аккаунт?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Отмена</Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await api.del('/me');
                  logout();
                  navigate('/login');
                } catch (error) {
                  toast((error as Error).message, 'error');
                }
              }}
            >
              Удалить навсегда
            </Button>
          </div>
        }
      >
        <div className="space-y-2">
          <p className="text-sm text-ink-muted">Действие необратимо. Ваши сообщения в общих чатах останутся, но автор будет анонимизирован.</p>
          <Input label="Подтвердите паролем" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
      </Modal>
    </div>
  );
}

function AdvancedSection({ settings, onChange, onLogoutAll }: { settings: UserSettings; onChange: (patch: Partial<UserSettings>) => void; onLogoutAll: () => void }) {
  const toast = useAppStore((state) => state.toast);
  const [serverInfo, setServerInfo] = useState<Record<string, unknown> | null>(null);
  return (
    <div className="space-y-4">
      <SectionCard title="Экспериментальные функции" icon="sliders">
        <Row label="Стикеры и GIF" description="Паки стикеров и поиск GIF из Tenor (нужен API-ключ сервера)">
          <Switch label="" checked={settings.experimental.stickers ?? true} onChange={(value) => onChange({ experimental: { ...settings.experimental, stickers: value } })} />
        </Row>
        <Row label="Истории" description="24-часовые истории">
          <Switch label="" checked={settings.experimental.stories ?? true} onChange={(value) => onChange({ experimental: { ...settings.experimental, stories: value } })} />
        </Row>
      </SectionCard>

      <SectionCard title="О сервере" icon="info">
        <div className="px-1 py-2">
          <Button variant="soft" onClick={async () => {
            const info = await api.get<Record<string, unknown>>('/config');
            setServerInfo(info);
          }}>Показать сведения</Button>
          {serverInfo ? (
            <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-surface-hover p-2 text-[11px]">{JSON.stringify(serverInfo, null, 2)}</pre>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard title="Сессии и выход" icon="logout">
        <div className="flex gap-2 px-1 py-2">
          <Button variant="ghost" onClick={async () => {
            await api.del('/me/sessions').catch(() => undefined);
            await api.post('/auth/logout').catch(() => undefined);
            onLogoutAll();
          }}>Выйти на всех устройствах</Button>
        </div>
      </SectionCard>

      <SectionCard title="Честно о функциях" icon="shield">
        <ul className="list-inside list-disc space-y-1 px-1 text-xs text-ink-muted">
          <li>Сообщения не используют E2E: владелец сервера технически может читать данные — шифрование только «на диске».</li>
          <li>Групповые звонки требуют внешнего SFU и в этой сборке не реализованы.</li>
          <li>Поиск GIF требует ключа Tenor; стикеры работают с локальными паками.</li>
          <li>Полный список: docs/LIMITATIONS.md в репозитории.</li>
        </ul>
      </SectionCard>
    </div>
  );
}
