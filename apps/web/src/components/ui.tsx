import { useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import clsx from 'clsx';
import { Icon, Logo } from './icons';
import { useAppStore } from '../store/app';

export function Spinner({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg className={clsx('animate-spin', className)} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Загрузка">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'soft' | 'danger';
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: string;
}) {
  const variantClass = {
    primary: 'btn-primary',
    ghost: 'btn-ghost',
    soft: 'btn-soft',
    danger: 'btn-danger',
  }[variant];
  return (
    <button className={clsx(variantClass, size === 'sm' && '!px-3 !py-1.5 !text-xs', className)} disabled={loading || rest.disabled} {...rest}>
      {loading ? <Spinner size={16} /> : icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

export function Input({ label, hint, error, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string }) {
  return (
    <label className="block">
      {label ? <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</span> : null}
      <input className={clsx('field', error && 'border-danger', className)} {...rest} />
      {error ? <span className="mt-1 block text-xs text-danger">{error}</span> : hint ? <span className="mt-1 block text-xs text-ink-faint">{hint}</span> : null}
    </label>
  );
}

export function Textarea({ label, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string }) {
  return (
    <label className="block">
      {label ? <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</span> : null}
      <textarea className={clsx('field min-h-[90px] resize-y', className)} {...rest} />
    </label>
  );
}

export function Switch({ checked, onChange, label, description }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 rounded-xl2 px-1 py-2 text-left"
    >
      <span>
        <span className="block text-sm font-medium text-ink">{label}</span>
        {description ? <span className="mt-0.5 block text-xs text-ink-faint">{description}</span> : null}
      </span>
      <span
        className={clsx('relative h-6 w-11 shrink-0 rounded-full transition-colors', checked ? 'bg-brand' : 'bg-surface-sunken border border-line')}
      >
        <span className={clsx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
      </span>
    </button>
  );
}

export function Select({ value, onChange, options, label }: { value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; label?: string }) {
  return (
    <label className="block">
      {label ? <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</span> : null}
      <select className="field" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

const gradientPalette = ['#4B3AF0', '#7B5CFF', '#12C2B4', '#F2748C', '#F2A63B', '#3C9DF2', '#9B5CF6', '#25B57F'];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash;
}

export function Avatar({
  name,
  src,
  size = 48,
  online,
  showOnline = false,
  className,
  seed,
}: {
  name: string;
  src?: string | null;
  size?: number;
  online?: boolean;
  showOnline?: boolean;
  className?: string;
  seed?: string;
}) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => [...part][0]?.toUpperCase() ?? '')
    .join('');
  const hash = hashString(seed ?? name);
  const from = gradientPalette[hash % gradientPalette.length];
  const to = gradientPalette[(hash + 3) % gradientPalette.length];
  return (
    <span className={clsx('relative inline-flex shrink-0 items-center justify-center overflow-visible', className)} style={{ width: size, height: size }}>
      <span
        className="flex h-full w-full items-center justify-center overflow-hidden rounded-full text-white"
        style={{
          background: src ? 'var(--surface-sunken)' : `linear-gradient(135deg, ${from}, ${to})`,
          fontSize: Math.max(11, size * 0.38),
          fontWeight: 600,
        }}
      >
        {src ? <img src={src} alt={name} className="h-full w-full object-cover" loading="lazy" /> : initials || '?'}
      </span>
      {showOnline ? (
        <span
          className={clsx('absolute bottom-0 right-0 rounded-full border-2', online ? 'bg-success' : 'bg-ink-faint')}
          style={{ width: size * 0.28, height: size * 0.28, borderColor: 'var(--surface)' }}
        />
      ) : null}
    </span>
  );
}

export function Badge({ children, tone = 'brand' }: { children: ReactNode; tone?: 'brand' | 'muted' | 'danger' | 'success' }) {
  const tones = {
    brand: 'bg-brand text-white',
    muted: 'bg-surface-hover text-ink-muted',
    danger: 'bg-danger text-white',
    success: 'bg-success text-white',
  } as const;
  return <span className={clsx('chip', tones[tone])}>{children}</span>;
}

export function EmptyState({ icon = 'chat', title, description, action }: { icon?: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center animate-fade-in">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-hover text-ink-faint">
        <Icon name={icon} size={28} />
      </span>
      <h3 className="text-base font-semibold">{title}</h3>
      {description ? <p className="max-w-sm text-sm text-ink-muted">{description}</p> : null}
      {action}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-sm animate-fade-in sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          'flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl3 bg-surface shadow-2xl animate-slide-up sm:rounded-xl3',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-md',
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть"><Icon name="close" /></button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <footer className="border-t border-line px-5 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useAppStore((state) => state.toasts);
  const dismiss = useAppStore((state) => state.dismissToast);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          onClick={() => dismiss(toast.id)}
          className={clsx(
            'pointer-events-auto max-w-sm rounded-xl2 px-4 py-2.5 text-sm font-medium shadow-lg animate-slide-up',
            toast.kind === 'error' ? 'bg-danger text-white' : toast.kind === 'success' ? 'bg-success text-white' : 'bg-ink text-surface',
          )}
        >
          {toast.title}
        </button>
      ))}
    </div>
  );
}

export function SkeletonList({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-1 p-2">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 px-2 py-2.5">
          <div className="skeleton h-12 w-12 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3 w-1/3" />
            <div className="skeleton h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SectionCard({ title, description, children, icon }: { title: string; description?: string; children: ReactNode; icon?: string }) {
  return (
    <section className="surface-card p-4 sm:p-5">
      <header className="mb-3 flex items-start gap-3">
        {icon ? <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-soft text-brand"><Icon name={icon} size={18} /></span> : null}
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {description ? <p className="mt-0.5 text-xs text-ink-muted">{description}</p> : null}
        </div>
      </header>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

export function Row({ label, description, children }: { label: string; description?: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line py-2.5 last:border-0">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {description ? <div className="text-xs text-ink-faint">{description}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <Logo size={compact ? 30 : 40} />
      <div className="leading-tight">
        <div className="text-[15px] font-semibold tracking-tight">Элиан</div>
        {!compact ? <div className="text-[11px] text-ink-faint">Общение без лишнего</div> : null}
      </div>
    </div>
  );
}

export function useCopy() {
  const toast = useAppStore((state) => state.toast);
  return async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Скопировано', 'success');
    } catch {
      toast('Не удалось скопировать', 'error');
    }
  };
}

export function useClickOutside<T extends HTMLElement>(onOutside: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutside();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onOutside]);
  return ref;
}
