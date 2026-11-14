-- Элиан / Elian — начальная схема. Версия 1.
-- Все внешние идентификаторы: ULID (TEXT). Время: ISO-8601 UTC (TEXT).

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name      TEXT NOT NULL,
  bio               TEXT,
  phone             TEXT,
  birth_date        TEXT,
  avatar_media_id   TEXT,
  last_seen_at      TEXT,
  settings          TEXT NOT NULL DEFAULT '{}',
  is_bot            INTEGER NOT NULL DEFAULT 0,
  premium           INTEGER NOT NULL DEFAULT 0,
  premium_until     TEXT,
  tfa_secret        TEXT,
  tfa_enabled       INTEGER NOT NULL DEFAULT 0,
  username_changed_at TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_deleted ON users(deleted_at);

CREATE TABLE IF NOT EXISTS credentials (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash     TEXT NOT NULL,
  algo              TEXT NOT NULL DEFAULT 'argon2id',
  password_changed_at TEXT NOT NULL,
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT
);

CREATE TABLE IF NOT EXISTS pending_auth_requests (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL CHECK (type IN ('REGISTRATION','LOGIN','PASSWORD_RESET')),
  username          TEXT NOT NULL,
  user_id           TEXT,
  display_name      TEXT,
  password_hash     TEXT,
  approval_secret_hash TEXT NOT NULL UNIQUE,
  code              TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  metadata          TEXT NOT NULL DEFAULT '{}',
  attempts          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  decided_at        TEXT,
  decided_by        TEXT,
  consumed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_auth_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_auth_requests(user_id, type);

CREATE TABLE IF NOT EXISTS devices (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint       TEXT NOT NULL,
  name              TEXT NOT NULL,
  platform          TEXT,
  user_agent        TEXT,
  created_at        TEXT NOT NULL,
  last_active_at    TEXT NOT NULL,
  UNIQUE(user_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id         TEXT,
  token_hash        TEXT NOT NULL UNIQUE,
  csrf_hash         TEXT NOT NULL,
  ip_masked         TEXT,
  user_agent        TEXT,
  created_at        TEXT NOT NULL,
  last_active_at    TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  revoked_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS contacts (
  owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (owner_id, contact_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason            TEXT,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (owner_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS media (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT,
  kind              TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  size              INTEGER NOT NULL,
  encrypted_size    INTEGER NOT NULL,
  file_name         TEXT,
  width             INTEGER,
  height            INTEGER,
  duration          REAL,
  waveform          TEXT,
  sha256            TEXT,
  storage_path      TEXT NOT NULL,
  thumb_path        TEXT,
  is_encrypted      INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_id, created_at);

CREATE TABLE IF NOT EXISTS chats (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL CHECK (type IN ('private','group','channel')),
  title             TEXT,
  username          TEXT UNIQUE COLLATE NOCASE,
  description       TEXT,
  avatar_media_id   TEXT,
  is_public         INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_message_at   TEXT,
  last_seq          INTEGER NOT NULL DEFAULT 0,
  member_count      INTEGER NOT NULL DEFAULT 0,
  slow_mode_seconds INTEGER NOT NULL DEFAULT 0,
  discussion_chat_id TEXT,
  linked_channel_id TEXT,
  default_permissions TEXT NOT NULL DEFAULT '{}',
  signature_enabled INTEGER NOT NULL DEFAULT 0,
  deleted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_chats_username ON chats(username);
CREATE INDEX IF NOT EXISTS idx_chats_last_message ON chats(last_message_at);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id           TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role              TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  permissions       TEXT NOT NULL DEFAULT '{}',
  joined_at         TEXT NOT NULL,
  invited_by        TEXT,
  muted_until       TEXT,
  banned            INTEGER NOT NULL DEFAULT 0,
  banned_at         TEXT,
  banned_by         TEXT,
  last_read_seq     INTEGER NOT NULL DEFAULT 0,
  last_delivered_seq INTEGER NOT NULL DEFAULT 0,
  pinned            INTEGER NOT NULL DEFAULT 0,
  archived          INTEGER NOT NULL DEFAULT 0,
  muted             INTEGER NOT NULL DEFAULT 0,
  muted_until_chat  TEXT,
  notifications     TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id);
CREATE INDEX IF NOT EXISTS idx_members_chat ON chat_members(chat_id, role);

CREATE TABLE IF NOT EXISTS roles (
  id                TEXT PRIMARY KEY,
  chat_id           TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  permissions       TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  key               TEXT PRIMARY KEY,
  description       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  chat_id           TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  sender_id         TEXT,
  text              TEXT NOT NULL DEFAULT '',
  entities          TEXT NOT NULL DEFAULT '[]',
  reply_to_id       TEXT,
  thread_root_id    TEXT,
  forwarded_from_chat_id TEXT,
  forwarded_from_user_id TEXT,
  forwarded_name    TEXT,
  author_signature  TEXT,
  silent            INTEGER NOT NULL DEFAULT 0,
  pinned            INTEGER NOT NULL DEFAULT 0,
  pinned_at         TEXT,
  via_bot_id        TEXT,
  client_message_id TEXT,
  has_media         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  edited_at         TEXT,
  deleted_at        TEXT,
  deleted_by        TEXT,
  UNIQUE(chat_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idem ON messages(chat_id, sender_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages(chat_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(chat_id, sender_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

CREATE TABLE IF NOT EXISTS message_edits (
  id                TEXT PRIMARY KEY,
  message_id        TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  text              TEXT NOT NULL,
  entities          TEXT NOT NULL DEFAULT '[]',
  edited_by         TEXT,
  edited_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  message_id        TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('delivered','read')),
  at                TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_receipts_user ON receipts(user_id, kind);

CREATE TABLE IF NOT EXISTS reactions (
  message_id        TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL,
  emoji             TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);

CREATE TABLE IF NOT EXISTS attachments (
  id                TEXT PRIMARY KEY,
  message_id        TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  position          INTEGER NOT NULL DEFAULT 0,
  media_id          TEXT,
  thumb_media_id    TEXT,
  file_name         TEXT,
  mime_type         TEXT,
  size              INTEGER,
  width             INTEGER,
  height            INTEGER,
  duration          REAL,
  waveform          TEXT,
  spoiler           INTEGER NOT NULL DEFAULT 0,
  latitude          REAL,
  longitude         REAL,
  contact_name      TEXT,
  contact_username  TEXT,
  poll_id           TEXT
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_media ON attachments(media_id);

CREATE TABLE IF NOT EXISTS polls (
  id                TEXT PRIMARY KEY,
  chat_id           TEXT NOT NULL,
  message_id        TEXT,
  question          TEXT NOT NULL,
  options           TEXT NOT NULL,
  anonymous         INTEGER NOT NULL DEFAULT 1,
  multiple          INTEGER NOT NULL DEFAULT 0,
  quiz              INTEGER NOT NULL DEFAULT 0,
  correct_option_id TEXT,
  closed            INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  poll_id           TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id         TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (poll_id, option_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id                TEXT PRIMARY KEY,
  chat_id           TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  token_hash        TEXT NOT NULL UNIQUE,
  token_hint        TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  expires_at        TEXT,
  max_uses          INTEGER,
  uses              INTEGER NOT NULL DEFAULT 0,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  revoked_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_chat ON invites(chat_id, revoked_at);

CREATE TABLE IF NOT EXISTS join_requests (
  id                TEXT PRIMARY KEY,
  chat_id           TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL,
  message           TEXT,
  invite_id         TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at        TEXT NOT NULL,
  decided_at        TEXT,
  decided_by        TEXT,
  UNIQUE(chat_id, user_id, status)
);

CREATE TABLE IF NOT EXISTS folders (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  emoji             TEXT,
  position          INTEGER NOT NULL DEFAULT 0,
  rules             TEXT NOT NULL DEFAULT '[]',
  included_chat_ids TEXT NOT NULL DEFAULT '[]',
  excluded_chat_ids TEXT NOT NULL DEFAULT '[]',
  unread_only       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id, position);

CREATE TABLE IF NOT EXISTS drafts (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id           TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  text              TEXT NOT NULL,
  reply_to_id       TEXT,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, chat_id)
);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id                TEXT PRIMARY KEY,
  chat_id           TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id         TEXT NOT NULL,
  text              TEXT NOT NULL,
  silent            INTEGER NOT NULL DEFAULT 0,
  send_at           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','cancelled','failed')),
  created_at        TEXT NOT NULL,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_messages(status, send_at);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  run_at            TEXT NOT NULL,
  payload           TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON scheduled_jobs(status, run_at);

CREATE TABLE IF NOT EXISTS notifications (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id           TEXT,
  message_id        TEXT,
  kind              TEXT NOT NULL,
  title             TEXT,
  body              TEXT,
  created_at        TEXT NOT NULL,
  read_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint          TEXT NOT NULL UNIQUE,
  p256dh            TEXT NOT NULL,
  auth              TEXT NOT NULL,
  user_agent        TEXT,
  created_at        TEXT NOT NULL,
  last_success_at   TEXT,
  failures          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS calls (
  id                TEXT PRIMARY KEY,
  chat_id           TEXT,
  initiator_id      TEXT NOT NULL,
  peer_id           TEXT,
  media             TEXT NOT NULL CHECK (media IN ('audio','video')),
  status            TEXT NOT NULL DEFAULT 'ringing',
  started_at        TEXT NOT NULL,
  answered_at       TEXT,
  ended_at          TEXT,
  duration_seconds  INTEGER NOT NULL DEFAULT 0,
  end_reason        TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_users ON calls(initiator_id, started_at DESC);

CREATE TABLE IF NOT EXISTS call_participants (
  call_id           TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL,
  joined_at         TEXT,
  left_at           TEXT,
  state             TEXT NOT NULL DEFAULT 'invited',
  PRIMARY KEY (call_id, user_id)
);

CREATE TABLE IF NOT EXISTS bots (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name      TEXT NOT NULL,
  token_hash        TEXT NOT NULL UNIQUE,
  token_hint        TEXT NOT NULL,
  webhook_url       TEXT,
  webhook_secret    TEXT,
  long_polling      INTEGER NOT NULL DEFAULT 1,
  commands          TEXT NOT NULL DEFAULT '[]',
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_updates (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id            TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  payload           TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  consumed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_bot_updates ON bot_updates(bot_id, consumed_at, id);

CREATE TABLE IF NOT EXISTS sticker_packs (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT,
  title             TEXT NOT NULL,
  short_name        TEXT NOT NULL UNIQUE,
  kind              TEXT NOT NULL DEFAULT 'static',
  is_public         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stickers (
  id                TEXT PRIMARY KEY,
  pack_id           TEXT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
  media_id          TEXT NOT NULL,
  emoji             TEXT,
  position          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_sticker_packs (
  user_id           TEXT NOT NULL,
  pack_id           TEXT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL DEFAULT 0,
  installed_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, pack_id)
);

CREATE TABLE IF NOT EXISTS stories (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('photo','video','text')),
  text              TEXT,
  media_id          TEXT,
  background        TEXT,
  privacy           TEXT NOT NULL DEFAULT 'contacts',
  privacy_list      TEXT NOT NULL DEFAULT '[]',
  duration          INTEGER NOT NULL DEFAULT 5,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  archived          INTEGER NOT NULL DEFAULT 0,
  deleted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_stories_user ON stories(user_id, expires_at);

CREATE TABLE IF NOT EXISTS story_views (
  story_id          TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL,
  viewed_at         TEXT NOT NULL,
  reaction          TEXT,
  PRIMARY KEY (story_id, user_id)
);

CREATE TABLE IF NOT EXISTS highlights (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS highlight_items (
  highlight_id      TEXT NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  story_id          TEXT NOT NULL,
  position          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (highlight_id, story_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id                TEXT PRIMARY KEY,
  reporter_id       TEXT,
  target_user_id    TEXT,
  target_chat_id    TEXT,
  message_id        TEXT,
  reason            TEXT NOT NULL,
  comment           TEXT,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','actioned','dismissed')),
  created_at        TEXT NOT NULL,
  reviewed_at       TEXT,
  reviewed_by       TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id                TEXT PRIMARY KEY,
  actor_id          TEXT,
  action            TEXT NOT NULL,
  target_type       TEXT,
  target_id         TEXT,
  metadata          TEXT NOT NULL DEFAULT '{}',
  ip_masked         TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC);

CREATE TABLE IF NOT EXISTS login_attempts (
  key               TEXT PRIMARY KEY,
  count             INTEGER NOT NULL DEFAULT 0,
  window_start      TEXT NOT NULL,
  blocked_until     TEXT
);

CREATE TABLE IF NOT EXISTS app_meta (
  key               TEXT PRIMARY KEY,
  value             TEXT NOT NULL
);
