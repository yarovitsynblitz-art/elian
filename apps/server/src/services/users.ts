import type { PublicUser, SelfUser } from '@elian/shared';
import { all, get, run } from '../db/index.js';
import { parseSettings, DEFAULT_SETTINGS, type UserSettings } from './settings.js';
import { now } from '../lib/time.js';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  bio: string | null;
  phone: string | null;
  birth_date: string | null;
  avatar_media_id: string | null;
  last_seen_at: string | null;
  settings: string;
  is_bot: number;
  premium: number;
  premium_until: string | null;
  tfa_secret: string | null;
  tfa_enabled: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export function getUserById(id: string): UserRow | null {
  return get<UserRow>('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [id]) ?? null;
}

export function getUserByUsername(username: string): UserRow | null {
  return get<UserRow>('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL', [username]) ?? null;
}

export function userSettings(row: UserRow): UserSettings {
  return parseSettings(row.settings);
}

export function saveSettings(userId: string, patch: unknown): UserSettings {
  const row = getUserById(userId);
  const current = row ? userSettings(row) : structuredClone(DEFAULT_SETTINGS);
  const merged = parseSettings(JSON.stringify({ ...current, ...(patch as Record<string, unknown>) }));
  run('UPDATE users SET settings = ?, updated_at = ? WHERE id = ?', [JSON.stringify(merged), now(), userId]);
  return merged;
}

export function isContact(ownerId: string, contactId: string): boolean {
  return !!get('SELECT 1 FROM contacts WHERE owner_id = ? AND contact_id = ?', [ownerId, contactId]);
}

export function isBlocked(ownerId: string, blockedId: string): boolean {
  return !!get('SELECT 1 FROM blocks WHERE owner_id = ? AND blocked_id = ?', [ownerId, blockedId]);
}

function visibilityAllows(viewerId: string | null, ownerId: string, level: 'everybody' | 'contacts' | 'nobody', contactRelation: boolean): boolean {
  if (viewerId === ownerId) return true;
  if (level === 'everybody') return true;
  if (level === 'contacts') return contactRelation;
  return false;
}

export function toPublicUser(viewerId: string | null, row: UserRow): PublicUser {
  const settings = userSettings(row);
  const contact = viewerId ? isContact(viewerId, row.id) : false;
  const blocked = viewerId ? isBlocked(viewerId, row.id) : false;
  const blockedBy = viewerId ? isBlocked(row.id, viewerId) : false;
  const lastSeenVisible = visibilityAllows(viewerId, row.id, settings.privacy.lastSeen, contact);
  const online = !!row.last_seen_at && Date.now() - new Date(row.last_seen_at).getTime() < 90_000;
  const photoVisible = visibilityAllows(viewerId, row.id, settings.privacy.profilePhoto, contact);
  const phoneVisible = viewerId === row.id || visibilityAllows(viewerId, row.id, settings.privacy.phone, contact);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_media_id && photoVisible ? `/api/v1/media/${row.avatar_media_id}/content` : null,
    lastSeenAt: lastSeenVisible ? row.last_seen_at : null,
    online: lastSeenVisible && online,
    isContact: contact,
    isBlocked: blocked,
    isBlockedBy: blockedBy,
    isBot: Boolean(row.is_bot),
    premium: Boolean(row.premium),
    birthDate: visibilityAllows(viewerId, row.id, settings.privacy.lastSeen, contact) ? row.birth_date : null,
    phone: phoneVisible ? row.phone : null,
  };
}

export function toSelf(row: UserRow): SelfUser {
  const pub = toPublicUser(row.id, row);
  return {
    ...pub,
    createdAt: row.created_at,
    tfaEnabled: Boolean(row.tfa_enabled),
    phoneVisible: userSettings(row).showPhone,
  };
}

export function touchLastSeen(userId: string): void {
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', [now(), userId]);
}

export function contactIds(ownerId: string): string[] {
  return all<{ contact_id: string }>('SELECT contact_id FROM contacts WHERE owner_id = ?', [ownerId]).map((r) => r.contact_id);
}

export function blockedIds(ownerId: string): string[] {
  return all<{ blocked_id: string }>('SELECT blocked_id FROM blocks WHERE owner_id = ?', [ownerId]).map((r) => r.blocked_id);
}

export function mutualBlocked(a: string, b: string): boolean {
  return isBlocked(a, b) || isBlocked(b, a);
}

/** Проверка, что пользователь может писать другому (учитывает блокировки). */
export function canMessage(senderId: string, recipientId: string): boolean {
  return !mutualBlocked(senderId, recipientId);
}

export function searchUsers(prefix: string, viewerId: string, limit = 20): UserRow[] {
  const normalized = prefix.replace(/^@/, '').toLowerCase();
  if (!normalized) return [];
  const rows = all<UserRow>(
    `SELECT * FROM users
     WHERE deleted_at IS NULL AND is_bot = 0
       AND (lower(username) = ? OR lower(username) LIKE ?)
       AND (username <> ?)
     ORDER BY CASE WHEN lower(username) = ? THEN 0 ELSE 1 END, username
     LIMIT ?`,
    [normalized, `${normalized}%`, '', normalized, limit],
  );
  return rows.filter((row) => {
    const settings = userSettings(row);
    if (!settings.privacy.searchByUsername) return false;
    if (isBlocked(row.id, viewerId)) return false;
    return true;
  });
}
