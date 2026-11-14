import { create } from 'zustand';
import type { ChatSummary, Message, SelfUser } from '@elian/shared';
import { useI18nStore, type Locale } from '../lib/i18n';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface Toast {
  id: string;
  title: string;
  kind: 'info' | 'error' | 'success';
}

interface AuthSlice {
  user: SelfUser | null;
  status: 'loading' | 'anon' | 'authed';
  setUser: (user: SelfUser | null) => void;
  setStatus: (status: AuthSlice['status']) => void;
  logout: () => void;
}

interface UiSlice {
  theme: ThemeMode;
  accent: string;
  textSize: 'compact' | 'normal' | 'large' | 'xlarge';
  reducedMotion: boolean;
  compactMode: boolean;
  activeChatId: string | null;
  rightPanel: 'none' | 'profile' | 'members' | 'media';
  mobileView: 'list' | 'chat' | 'panel';
  composerReply: Message | null;
  composerEdit: Message | null;
  toasts: Toast[];
  installPrompt: boolean;
  online: boolean;
  setTheme: (theme: ThemeMode) => void;
  setAccent: (accent: string) => void;
  setTextSize: (size: UiSlice['textSize']) => void;
  setReducedMotion: (value: boolean) => void;
  setCompactMode: (value: boolean) => void;
  setActiveChat: (id: string | null) => void;
  setRightPanel: (panel: UiSlice['rightPanel']) => void;
  setMobileView: (view: UiSlice['mobileView']) => void;
  setComposerReply: (message: Message | null) => void;
  setComposerEdit: (message: Message | null) => void;
  toast: (title: string, kind?: Toast['kind']) => void;
  dismissToast: (id: string) => void;
  setOnline: (online: boolean) => void;
  setInstallPrompt: (value: boolean) => void;
  applyAppearance: () => void;
}

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

const storedTheme = readStored<ThemeMode>('elian.theme', 'system');
const storedAccent = localStorage.getItem('elian.accent') ?? '#4B3AF0';
const storedTextSize = readStored<UiSlice['textSize']>('elian.textSize', 'normal');
const storedReducedMotion = readStored<boolean>('elian.reducedMotion', false);
const storedCompact = readStored<boolean>('elian.compact', false);

export const useAppStore = create<AuthSlice & UiSlice>((set, get) => ({
  user: null,
  status: 'loading',
  setUser: (user) => set({ user, status: user ? 'authed' : 'anon' }),
  setStatus: (status) => set({ status }),
  logout: () => set({ user: null, status: 'anon', activeChatId: null }),

  theme: storedTheme,
  accent: storedAccent,
  textSize: storedTextSize,
  reducedMotion: storedReducedMotion,
  compactMode: storedCompact,
  activeChatId: null,
  rightPanel: 'none',
  mobileView: 'list',
  composerReply: null,
  composerEdit: null,
  toasts: [],
  installPrompt: false,
  online: navigator.onLine,

  setTheme: (theme) => {
    localStorage.setItem('elian.theme', JSON.stringify(theme));
    set({ theme });
    get().applyAppearance();
  },
  setAccent: (accent) => {
    localStorage.setItem('elian.accent', accent);
    set({ accent });
    get().applyAppearance();
  },
  setTextSize: (textSize) => {
    localStorage.setItem('elian.textSize', JSON.stringify(textSize));
    set({ textSize });
    get().applyAppearance();
  },
  setReducedMotion: (reducedMotion) => {
    localStorage.setItem('elian.reducedMotion', JSON.stringify(reducedMotion));
    set({ reducedMotion });
    get().applyAppearance();
  },
  setCompactMode: (compactMode) => {
    localStorage.setItem('elian.compact', JSON.stringify(compactMode));
    set({ compactMode });
  },
  setActiveChat: (activeChatId) => set({ activeChatId }),
  setRightPanel: (rightPanel) => set({ rightPanel }),
  setMobileView: (mobileView) => set({ mobileView }),
  setComposerReply: (composerReply) => set({ composerReply }),
  setComposerEdit: (composerEdit) => set({ composerEdit }),
  toast: (title, kind = 'info') => {
    const id = crypto.randomUUID();
    set({ toasts: [...get().toasts, { id, title, kind }] });
    setTimeout(() => get().dismissToast(id), 4200);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),
  setOnline: (online) => set({ online }),
  setInstallPrompt: (installPrompt) => set({ installPrompt }),
  applyAppearance: () => {
    const { theme, accent, textSize, reducedMotion, compactMode } = get();
    const root = document.documentElement;
    root.dataset.theme = resolveTheme(theme);
    root.dataset.textSize = textSize;
    root.dataset.reducedMotion = String(reducedMotion);
    root.dataset.compact = String(compactMode);
    root.style.setProperty('--brand', accent);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolveTheme(theme) === 'dark' ? '#141228' : '#4B3AF0');
  },
}));

export function syncLocaleFromSettings(locale: Locale | undefined): void {
  if (locale) useI18nStore.getState().setLocale(locale);
}

export function useActiveChat(): ChatSummary | null {
  const activeChatId = useAppStore((state) => state.activeChatId);
  return useChatIndex((state) => (activeChatId ? state.chats.get(activeChatId) ?? null : null));
}

interface ChatIndexState {
  chats: Map<string, ChatSummary>;
  setChats: (chats: ChatSummary[]) => void;
  upsertChat: (chat: ChatSummary) => void;
  removeChat: (chatId: string) => void;
  patchChat: (chatId: string, patch: Partial<ChatSummary>) => void;
}

export const useChatIndex = create<ChatIndexState>((set, get) => ({
  chats: new Map(),
  setChats: (chats) => set({ chats: new Map(chats.map((chat) => [chat.id, chat])) }),
  upsertChat: (chat) => {
    const next = new Map(get().chats);
    const existing = next.get(chat.id);
    next.set(chat.id, existing ? { ...existing, ...chat } : chat);
    set({ chats: next });
  },
  removeChat: (chatId) => {
    const next = new Map(get().chats);
    next.delete(chatId);
    set({ chats: next });
  },
  patchChat: (chatId, patch) => {
    const next = new Map(get().chats);
    const existing = next.get(chatId);
    if (existing) next.set(chatId, { ...existing, ...patch });
    set({ chats: next });
  },
}));
