export const BRAND = {
  name: 'Элиан',
  nameLatin: 'Elian',
  tagline: 'Общение без лишнего',
  primary: '#4B3AF0',
  secondary: '#12C2B4',
} as const;

export const LIMITS = {
  usernameMin: 4,
  usernameMax: 32,
  displayNameMax: 64,
  bioMax: 255,
  passwordMin: 10,
  passwordMax: 200,
  messageMax: 4096,
  captionMax: 1024,
  uploadBytesDefault: 100 * 1024 * 1024,
  folderNameMax: 40,
  chatTitleMax: 128,
  chatDescriptionMax: 1024,
  storiesPerDay: 30,
  codeTtlMinutes: 5,
  pendingTtlMinutes: 5,
} as const;

export const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'elian', 'support', 'help', 'root', 'system', 'owner', 'moderator', 'mod',
  'api', 'bot', 'bots', 'settings', 'login', 'register', 'auth', 'security', 'official', 'news',
  'telegram', 'whatsapp', 'signal', 'null', 'undefined', 'anonymous', 'everyone', 'all', 'me', 'you',
]);

export const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;
export const CHANNEL_USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;
export const REACTION_WHITELIST = [
  '👍', '❤️', '🔥', '😂', '🎉', '🙏', '👏', '😮', '😢', '😡', '✅', '👀', '💯', '🤔', '🥰', '😍',
] as const;

export const ROLE_PERMISSION_MATRIX = {
  owner: 'all',
  admin: 'admin-defaults',
  member: 'member-defaults',
} as const;

export const CALL_END_REASONS = ['hangup', 'busy', 'decline', 'timeout', 'no_turn', 'ice_failed', 'aborted'] as const;
