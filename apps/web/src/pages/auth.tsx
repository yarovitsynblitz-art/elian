import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { PendingStatus, SelfUser } from '@elian/shared';
import { api, ApiError } from '../lib/api';
import { useAppStore } from '../store/app';
import { useT } from '../lib/i18n';
import { connectSocket, disconnectSocket } from '../lib/socket';
import { BrandMark, Button, Input, Spinner } from '../components/ui';
import { Icon } from '../components/icons';

interface PendingContext {
  kind: 'login' | 'registration' | 'reset';
  requestId: string;
  approvalSecret: string;
  expiresAt: string;
}

const STORAGE_KEY = 'elian.pending';

export function savePending(context: PendingContext): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(context));
}

export function readPending(): PendingContext | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PendingContext) : null;
  } catch {
    return null;
  }
}

export function clearPending(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="wallpaper flex min-h-full flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <BrandMark />
        </div>
        <div className="surface-card p-6 shadow-xl animate-slide-up">{children}</div>
        <p className="mt-4 text-center text-xs text-ink-faint">
          Элиан — самостоятельный сервер. Это не Telegram и не связан с ним.
        </p>
      </div>
    </div>
  );
}

export function LoginPage() {
  const t = useT();
  const navigate = useNavigate();
  const toast = useAppStore((state) => state.toast);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await api.post<{ status: string; requestId: string; approvalSecret: string; expiresAt: string }>('/auth/login', {
        username,
        password,
        totp: totp || undefined,
      });
      savePending({ kind: 'login', requestId: result.requestId, approvalSecret: result.approvalSecret, expiresAt: result.expiresAt });
      navigate('/pending');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'tfa_required') {
        setNeedsTotp(true);
        setError('Введите код из приложения-аутентификатора');
      } else {
        setError(err instanceof ApiError ? err.message : 'Не удалось войти');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout>
      <h1 className="text-xl font-semibold">{t('auth.login.title')}</h1>
      <p className="mt-1 text-sm text-ink-muted">{t('auth.login.subtitle')}</p>
      <form className="mt-5 space-y-3" onSubmit={submit}>
        <Input
          label={t('auth.username')}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          placeholder="username"
          required
        />
        <Input
          label={t('auth.password')}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
        {needsTotp ? (
          <Input label="Код 2FA" value={totp} onChange={(event) => setTotp(event.target.value)} inputMode="numeric" placeholder="000000" />
        ) : null}
        {error ? <p className="rounded-xl2 bg-surface-hover px-3 py-2 text-xs text-danger">{error}</p> : null}
        <Button type="submit" loading={loading} className="w-full">Войти</Button>
      </form>
      <div className="mt-4 flex items-center justify-between text-sm">
        <Link to="/register" className="font-medium text-brand hover:underline">{t('auth.toRegister')}</Link>
        <Link to="/reset" className="text-ink-muted hover:underline">{t('auth.forgot')}</Link>
      </div>
      <div className="mt-5 flex items-start gap-2 rounded-xl2 bg-surface-hover p-3 text-xs text-ink-muted">
        <Icon name="shield" size={16} />
        <span>Вход подтверждает владелец сервера в Termux. Код подтверждения виден только ему.</span>
      </div>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const t = useT();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('Пароли не совпадают');
      return;
    }
    setLoading(true);
    try {
      const result = await api.post<{ requestId: string; approvalSecret: string; expiresAt: string }>('/auth/register', {
        username,
        displayName,
        password,
      });
      savePending({ kind: 'registration', requestId: result.requestId, approvalSecret: result.approvalSecret, expiresAt: result.expiresAt });
      navigate('/pending');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить заявку');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout>
      <h1 className="text-xl font-semibold">{t('auth.register.title')}</h1>
      <p className="mt-1 text-sm text-ink-muted">{t('auth.register.subtitle')}</p>
      <form className="mt-5 space-y-3" onSubmit={submit}>
        <Input label={t('auth.displayName')} value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={64} required />
        <Input
          label={t('auth.username')}
          value={username}
          onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
          hint="4–32 символа: латиница, цифры, _. Начинается с буквы."
          autoComplete="username"
          required
        />
        <Input label={t('auth.password')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} hint="Минимум 10 символов" autoComplete="new-password" required />
        <Input label="Повторите пароль" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        {error ? <p className="rounded-xl2 bg-surface-hover px-3 py-2 text-xs text-danger">{error}</p> : null}
        <Button type="submit" loading={loading} className="w-full">Отправить заявку</Button>
      </form>
      <Link to="/login" className="mt-4 block text-center text-sm font-medium text-brand hover:underline">{t('auth.toLogin')}</Link>
    </AuthLayout>
  );
}

export function PendingPage() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setUser = useAppStore((state) => state.setUser);
  const pending = readPending();
  const [status, setStatus] = useState<PendingStatus>('pending');
  const [secondsLeft, setSecondsLeft] = useState(() => {
    if (!pending) return 0;
    return Math.max(0, Math.round((new Date(pending.expiresAt).getTime() - Date.now()) / 1000));
  });
  const [resetTicket, setResetTicket] = useState<string | null>(null);

  useEffect(() => {
    if (!pending) {
      navigate('/login');
      return;
    }
    const socket = connectSocket(pending.approvalSecret);
    socket.on('connect', () => socket.emit('auth:watch_pending', { requestId: pending.requestId }, () => {}));
    socket.on('auth:pending_status', (payload) => {
      if (payload.requestId === pending.requestId) setStatus(payload.status);
    });
    const poll = setInterval(async () => {
      try {
        const result = await api.post<{ status: PendingStatus }>('/auth/pending/status', {
          requestId: pending.requestId,
          approvalSecret: pending.approvalSecret,
        });
        setStatus(result.status);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 410)) setStatus('expired');
      }
    }, 2500);
    const tick = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.round((new Date(pending.expiresAt).getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      socket.off('auth:pending_status');
      disconnectSocket();
    };
  }, [navigate, pending?.requestId]);

  useEffect(() => {
    if (!pending || status !== 'approved') return;
    (async () => {
      try {
        if (pending.kind === 'login') {
          const result = await api.post<{ user: SelfUser }>('/auth/pending/exchange', {
            requestId: pending.requestId,
            approvalSecret: pending.approvalSecret,
          });
          clearPending();
          setUser(result.user);
          await queryClient.invalidateQueries();
          navigate('/', { replace: true });
        } else if (pending.kind === 'registration') {
          const result = await api.post<{ user: SelfUser }>('/auth/pending/exchange-registration', {
            requestId: pending.requestId,
            approvalSecret: pending.approvalSecret,
          });
          clearPending();
          setUser(result.user);
          await queryClient.invalidateQueries();
          navigate('/', { replace: true });
        } else {
          const result = await api.post<{ resetTicket: string }>('/auth/pending/exchange-reset', {
            requestId: pending.requestId,
            approvalSecret: pending.approvalSecret,
          });
          setResetTicket(result.resetTicket);
          clearPending();
        }
      } catch (error) {
        if (error instanceof ApiError) setStatus(error.code === 'pending' ? 'pending' : 'expired');
      }
    })();
  }, [status]);

  if (!pending) return null;

  if (resetTicket) {
    return <ResetComplete ticket={resetTicket} />;
  }

  return (
    <AuthLayout>
      <div className="flex flex-col items-center gap-4 py-2 text-center">
        {status === 'pending' ? (
          <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-brand-soft text-brand">
            <Spinner size={28} />
          </span>
        ) : (
          <span className={`flex h-16 w-16 items-center justify-center rounded-full ${status === 'approved' ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>
            <Icon name={status === 'approved' ? 'check' : 'close'} size={30} />
          </span>
        )}
        <h1 className="text-lg font-semibold">
          {status === 'pending' ? t('pending.title') : status === 'approved' ? 'Подтверждено' : status === 'rejected' ? t('pending.rejected') : t('pending.expired')}
        </h1>
        <p className="text-sm text-ink-muted">
          {status === 'pending'
            ? t('pending.body')
            : status === 'rejected'
              ? 'Владелец сервера отклонил запрос. Можно попробовать снова.'
              : 'Запрос истёк. Повторите попытку.'}
        </p>
        <div className="w-full rounded-xl2 bg-surface-hover p-3 text-left text-xs text-ink-muted">
          <div className="flex justify-between py-0.5"><span>{t('pending.requestId')}</span><span className="font-mono">{pending.requestId.slice(0, 8)}</span></div>
          <div className="flex justify-between py-0.5"><span>{t('pending.expires')}</span><span>{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</span></div>
          <div className="flex justify-between py-0.5"><span>Тип</span><span>{pending.kind === 'registration' ? 'Регистрация' : pending.kind === 'login' ? 'Вход' : 'Сброс пароля'}</span></div>
        </div>
        {status !== 'pending' && status !== 'approved' ? (
          <div className="flex w-full gap-2">
            <Button variant="soft" className="flex-1" onClick={() => { clearPending(); navigate('/login'); }}>{t('common.back')}</Button>
            <Button className="flex-1" onClick={() => { clearPending(); navigate('/login'); }}>{t('common.retry')}</Button>
          </div>
        ) : (
          <Button variant="ghost" onClick={() => { clearPending(); navigate('/login'); }}>{t('pending.cancel')}</Button>
        )}
      </div>
    </AuthLayout>
  );
}

function ResetComplete({ ticket }: { ticket: string }) {
  const navigate = useNavigate();
  const toast = useAppStore((state) => state.toast);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError('Пароли не совпадают');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/reset/complete', { ticket, newPassword: password });
      toast('Пароль изменён. Войдите заново.', 'success');
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сменить пароль');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout>
      <h1 className="text-lg font-semibold">Новый пароль</h1>
      <p className="mt-1 text-sm text-ink-muted">Владелец подтвердил сброс. Задайте новый пароль — все сессии будут завершены.</p>
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <Input label="Новый пароль" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
        <Input label="Повторите пароль" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        {error ? <p className="text-xs text-danger">{error}</p> : null}
        <Button type="submit" loading={loading} className="w-full">Сохранить пароль</Button>
      </form>
    </AuthLayout>
  );
}

export function ResetRequestPage() {
  const t = useT();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      // Секрет генерирует клиент: сервер не раскрывает, существует ли аккаунт.
      const clientSecret = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
      const result = await api.post<{ status: string }>('/auth/reset', { username, clientSecret });
      if (result.status === 'accepted') {
        savePending({
          kind: 'reset',
          requestId: '',
          approvalSecret: clientSecret,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        });
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить запрос');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout>
      <h1 className="text-xl font-semibold">{t('auth.reset.title')}</h1>
      <p className="mt-1 text-sm text-ink-muted">{t('auth.reset.subtitle')}</p>
      {sent ? (
        <div className="mt-4 space-y-4">
          <p className="rounded-xl2 bg-surface-hover p-3 text-sm">{t('auth.reset.sent')}</p>
          <p className="text-xs text-ink-faint">
            Когда владелец подтвердит запрос в Termux, вернитесь на эту страницу и нажмите «Проверить статус».
          </p>
          <Button className="w-full" onClick={() => navigate('/reset/status')}>Проверить статус</Button>
        </div>
      ) : (
        <form className="mt-4 space-y-3" onSubmit={submit}>
          <Input label={t('auth.username')} value={username} onChange={(event) => setUsername(event.target.value)} required />
          {error ? <p className="text-xs text-danger">{error}</p> : null}
          <Button type="submit" loading={loading} className="w-full">{t('auth.reset.send')}</Button>
        </form>
      )}
      <Link to="/login" className="mt-4 block text-center text-sm text-ink-muted hover:underline">{t('auth.toLogin')}</Link>
    </AuthLayout>
  );
}

/** Ожидание подтверждения сброса: клиент опрашивает статус по своему секрету. */
export function ResetStatusPage() {
  const pendingCtx = readPending();
  const [ticket, setTicket] = useState<string | null>(null);
  const [status, setStatus] = useState<PendingStatus>('pending');
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!pendingCtx || pendingCtx.kind !== 'reset') return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const result = await api.post<{ found: boolean; requestId?: string; status?: PendingStatus }>('/auth/reset/status', {
          clientSecret: pendingCtx.approvalSecret,
        });
        if (!result.found || !result.requestId) {
          setNotFound(true);
          return;
        }
        setNotFound(false);
        setStatus(result.status ?? 'pending');
        if (result.status === 'approved') {
          const exchange = await api.post<{ resetTicket: string }>('/auth/pending/exchange-reset', {
            requestId: result.requestId,
            approvalSecret: pendingCtx.approvalSecret,
          });
          stopped = true;
          setTicket(exchange.resetTicket);
          clearPending();
        }
      } catch {
        /* запрос ещё не создан/не подтверждён */
      }
    };
    void tick();
    const interval = setInterval(tick, 2500);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [pendingCtx?.approvalSecret]);

  if (ticket) return <ResetComplete ticket={ticket} />;
  if (!pendingCtx) {
    return (
      <AuthLayout>
        <p className="text-sm">Запрос не найден. <Link className="text-brand" to="/reset">Начните заново</Link>.</p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout>
      <div className="flex flex-col items-center gap-3 text-center">
        {status === 'rejected' || status === 'expired' ? (
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-danger/15 text-danger"><Icon name="close" size={26} /></span>
        ) : (
          <Spinner size={28} />
        )}
        <h1 className="text-lg font-semibold">
          {status === 'rejected' ? 'Запрос отклонён владельцем' : status === 'expired' ? 'Срок запроса истёк' : 'Ожидаем подтверждение владельца'}
        </h1>
        <p className="text-sm text-ink-muted">
          {status === 'pending'
            ? 'Если аккаунт существует, владелец увидит запрос в консоли Termux и подтвердит его.'
            : 'Вернитесь на страницу восстановления и отправьте запрос заново.'}
        </p>
        {notFound ? <p className="text-xs text-ink-faint">Запрос ещё не зарегистрирован на сервере.</p> : null}
        <Link to="/reset" className="text-sm font-medium text-brand hover:underline">Начать заново</Link>
      </div>
    </AuthLayout>
  );
}
