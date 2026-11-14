export interface PrivacySettings {
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
}

export interface NotificationSettings {
  private: boolean;
  groups: boolean;
  channels: boolean;
  sound: boolean;
  vibration: boolean;
  preview: boolean;
  mentionsOnly: boolean;
}

export interface AppearanceSettings {
  theme: 'light' | 'dark' | 'system';
  accent: string;
  textSize: number;
  compact: boolean;
  animations: boolean;
  wallpaper: string | null;
}

export interface ChatSettings {
  sendOnEnter: boolean;
  drafts: boolean;
  autoDownload: 'always' | 'wifi' | 'never';
  defaultReactions: string[];
}

export interface BusinessSettings {
  enabled: boolean;
  greeting: string | null;
  away: string | null;
  quickReplies: string[];
  hours: { from: string; to: string; days: number[] } | null;
}

export interface UserSettings {
  privacy: PrivacySettings;
  notifications: NotificationSettings;
  appearance: AppearanceSettings;
  chats: ChatSettings;
  business: BusinessSettings;
  language: 'ru' | 'en';
  showPhone: boolean;
  experimental: Record<string, boolean>;
}

export const DEFAULT_SETTINGS: UserSettings = {
  privacy: {
    lastSeen: 'everybody',
    profilePhoto: 'everybody',
    calls: 'everybody',
    phone: 'nobody',
    forwarding: true,
    groupInvites: 'everybody',
    searchByUsername: true,
    readReceipts: true,
    stories: 'contacts',
    closeFriends: [],
  },
  notifications: { private: true, groups: true, channels: true, sound: true, vibration: true, preview: true, mentionsOnly: false },
  appearance: { theme: 'system', accent: '#4B3AF0', textSize: 1, compact: false, animations: true, wallpaper: null },
  chats: { sendOnEnter: true, drafts: true, autoDownload: 'wifi', defaultReactions: ['👍', '❤️', '🔥'] },
  business: { enabled: false, greeting: null, away: null, quickReplies: [], hours: null },
  language: 'ru',
  showPhone: false,
  experimental: {},
};

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch == null) return base;
  if (typeof base !== 'object' || base === null) return (patch as T) ?? base;
  if (typeof patch !== 'object') return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = (base as Record<string, unknown>)[key];
    if (current && typeof current === 'object' && !Array.isArray(current) && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(current, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

export function parseSettings(raw: unknown): UserSettings {
  if (!raw) return structuredClone(DEFAULT_SETTINGS);
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return deepMerge(structuredClone(DEFAULT_SETTINGS), parsed);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}
