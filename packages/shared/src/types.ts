/**
 * Общие типы Элиан / Elian (используются сервером и веб-клиентом).
 * Все внешние идентификаторы — ULID (26 символов Crockford base32).
 */

export type Ulid = string;
export type ISO = string;

export type ID = Ulid;

export type UserId = ID;
export type ChatId = ID;
export type MessageId = ID;

export interface PublicUser {
  id: UserId;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  /** null если скрыт настройками приватности */
  lastSeenAt: ISO | null;
  online: boolean;
  isContact: boolean;
  isBlocked: boolean;
  isBlockedBy: boolean;
  isBot: boolean;
  premium: boolean;
  birthDate: string | null;
  phone: string | null;
}

export interface SelfUser extends PublicUser {
  createdAt: ISO;
  tfaEnabled: boolean;
  phoneVisible: boolean;
}

export type ChatType = 'private' | 'group' | 'channel';

export type MemberRole = 'owner' | 'admin' | 'member';

export interface ChatPermissions {
  sendMessages: boolean;
  sendMedia: boolean;
  inviteUsers: boolean;
  pinMessages: boolean;
  manageMessages: boolean;
  banUsers: boolean;
  muteUsers: boolean;
  manageInvites: boolean;
  manageChat: boolean;
  anonymous: boolean;
}

export const DEFAULT_MEMBER_PERMISSIONS: ChatPermissions = {
  sendMessages: true,
  sendMedia: true,
  inviteUsers: true,
  pinMessages: false,
  manageMessages: false,
  banUsers: false,
  muteUsers: false,
  manageInvites: false,
  manageChat: false,
  anonymous: false,
};

export const DEFAULT_ADMIN_PERMISSIONS: ChatPermissions = {
  sendMessages: true,
  sendMedia: true,
  inviteUsers: true,
  pinMessages: true,
  manageMessages: true,
  banUsers: true,
  muteUsers: true,
  manageInvites: true,
  manageChat: false,
  anonymous: false,
};

export interface ChatSummary {
  id: ChatId;
  type: ChatType;
  title: string;
  username: string | null;
  avatarUrl: string | null;
  /** Кол-во непрочитанных */
  unreadCount: number;
  unreadMentions: number;
  pinned: boolean;
  archived: boolean;
  muted: boolean;
  mutedUntil: ISO | null;
  lastMessageAt: ISO | null;
  lastMessagePreview: string | null;
  lastMessageSenderId: UserId | null;
  memberCount: number;
  draftText: string | null;
  role: MemberRole | null;
  isPublic: boolean;
  description: string | null;
  slowModeSeconds: number;
  permissions: ChatPermissions | null;
  pinnedMessageId: MessageId | null;
  firstUnreadMessageId?: MessageId | null;
  readOutboxMaxSeq?: number;
}

export type AttachmentKind =
  | 'photo'
  | 'video'
  | 'audio'
  | 'voice'
  | 'video_note'
  | 'file'
  | 'sticker'
  | 'gif'
  | 'location'
  | 'contact'
  | 'poll';

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  mediaId: string | null;
  fileName: string | null;
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  /** пики waveform 0..100 для голосовых/аудио */
  waveform: number[] | null;
  thumbnailMediaId: string | null;
  spoiler: boolean;
  /** для location */
  latitude?: number | null;
  longitude?: number | null;
  /** для contact */
  contactName?: string | null;
  contactUsername?: string | null;
  /** для опроса */
  pollId?: string | null;
  url: string | null;
  thumbUrl: string | null;
  downloadUrl: string | null;
}

export interface PollOption {
  id: string;
  text: string;
  votes: number;
}

export interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  anonymous: boolean;
  multiple: boolean;
  quiz: boolean;
  correctOptionId: string | null;
  closed: boolean;
  totalVotes: number;
  votedOptionIds: string[];
  createdBy: UserId;
}

export interface Message {
  id: MessageId;
  chatId: ChatId;
  seq: number;
  senderId: UserId | null;
  sender: Pick<PublicUser, 'id' | 'username' | 'displayName' | 'avatarUrl'> | null;
  /** для каналов/анонимных админов */
  authorSignature: string | null;
  text: string;
  entities: MessageEntity[];
  attachments: Attachment[];
  poll: Poll | null;
  replyToId: MessageId | null;
  replyTo: {
    id: MessageId;
    text: string;
    senderId: UserId | null;
    senderName: string | null;
    attachmentKind: AttachmentKind | null;
  } | null;
  forwardedFrom: { chatId: ChatId | null; userId: UserId | null; name: string } | null;
  createdAt: ISO;
  editedAt: ISO | null;
  deletedAt: ISO | null;
  pinned: boolean;
  silent: boolean;
  viaBotId: string | null;
  reactions: ReactionSummary[];
  /** Доставлено/прочитано для личных чатов */
  deliveredToAll: boolean;
  readByAll: boolean;
  clientMessageId: string | null;
  threadRootId: MessageId | null;
  isOutgoing?: boolean;
}

export interface MessageEntity {
  type: 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'pre' | 'spoiler' | 'text_link' | 'mention' | 'hashtag' | 'quote';
  offset: number;
  length: number;
  url?: string;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  byMe: boolean;
  recentUserIds: UserId[];
}

export interface MessagePage {
  messages: Message[];
  hasMore: boolean;
  /** seq самого старого сообщения в выдаче */
  oldestSeq: number | null;
}

export interface SessionInfo {
  id: string;
  device: string;
  platform: string | null;
  ipMasked: string | null;
  createdAt: ISO;
  lastActiveAt: ISO;
  current: boolean;
}

export interface Draft {
  chatId: ChatId;
  text: string;
  updatedAt: ISO;
}

export interface FolderRule {
  type: 'chat' | 'type' | 'unread' | 'contact' | 'hasMedia' | 'pinned' | 'muted';
  value?: string | null;
  include: boolean;
}

export interface Folder {
  id: string;
  name: string;
  emoji: string | null;
  position: number;
  rules: FolderRule[];
  includedChatIds: ChatId[];
  excludedChatIds: ChatId[];
  unreadOnly: boolean;
}

export interface Story {
  id: string;
  userId: UserId;
  user: Pick<PublicUser, 'id' | 'username' | 'displayName' | 'avatarUrl'>;
  kind: 'photo' | 'video' | 'text';
  text: string | null;
  mediaId: string | null;
  url: string | null;
  thumbUrl: string | null;
  background: string | null;
  duration: number;
  createdAt: ISO;
  expiresAt: ISO;
  viewCount: number;
  seen: boolean;
  privacy: StoryPrivacy;
}

export type StoryPrivacy = 'everyone' | 'contacts' | 'close_friends' | 'selected';

export interface CallInfo {
  id: string;
  chatId: ChatId | null;
  peer: Pick<PublicUser, 'id' | 'username' | 'displayName' | 'avatarUrl'> | null;
  direction: 'outgoing' | 'incoming';
  media: 'audio' | 'video';
  status: 'ringing' | 'active' | 'ended' | 'missed' | 'declined' | 'failed';
  startedAt: ISO;
  endedAt: ISO | null;
  durationSeconds: number;
  endReason: string | null;
}

export interface ApprovalOwnerView {
  requestId: string;
  type: 'REGISTRATION' | 'LOGIN' | 'PASSWORD_RESET';
  username: string;
  code: string;
  createdAt: ISO;
  expiresAt: ISO;
  device: string | null;
  ipMasked: string | null;
}

export type PendingStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export interface SearchResults {
  users: PublicUser[];
  chats: ChatSummary[];
  messages: Message[];
}
