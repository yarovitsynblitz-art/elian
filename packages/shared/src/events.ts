/** Типизированные Socket.IO события (клиент ↔ сервер). */
import type {
  CallInfo, ChatId, ChatSummary, Message, MessageId, PublicUser, ReactionSummary, UserId, ISO, PendingStatus,
} from './types.js';

export interface ServerToClientEvents {
  'message:new': (payload: { message: Message; chat: ChatSummary }) => void;
  'message:edited': (payload: { message: Message }) => void;
  'message:deleted': (payload: { chatId: ChatId; messageId: MessageId; forEveryone: boolean }) => void;
  'reaction:changed': (payload: { chatId: ChatId; messageId: MessageId; reactions: ReactionSummary[] }) => void;
  'receipt': (payload: { chatId: ChatId; messageIds: MessageId[]; userId: UserId; kind: 'delivered' | 'read'; at: ISO }) => void;
  'chat:updated': (payload: { chat: ChatSummary }) => void;
  'chat:removed': (payload: { chatId: ChatId }) => void;
  'presence:changed': (payload: { userId: UserId; online: boolean; lastSeenAt: ISO | null }) => void;
  'typing': (payload: { chatId: ChatId; userId: UserId; kind: 'typing' | 'voice' | 'upload' | 'stop' }) => void;
  'auth:pending_status': (payload: { requestId: string; status: PendingStatus }) => void;
  'auth:session_revoked': (payload: { sessionId: string }) => void;
  'call:signal': (payload: { callId: string; from: UserId; data: unknown; kind: 'offer' | 'answer' | 'ice' | 'hangup' | 'invite' | 'accept' | 'decline' }) => void;
  'call:state': (payload: CallInfo) => void;
  'story:new': (payload: { userId: UserId }) => void;
  'folder:updated': (payload: { folderId: string }) => void;
  'notification:new': (payload: { chatId: ChatId; message: Message }) => void;
  'bot:update': (payload: { botId: string }) => void;
  'error': (payload: { code: string; message: string }) => void;
}

export interface ClientToServerEvents {
  'chat:subscribe': (payload: { chatId: ChatId }, ack?: (ok: boolean) => void) => void;
  'chat:unsubscribe': (payload: { chatId: ChatId }) => void;
  'typing': (payload: { chatId: ChatId; kind: 'typing' | 'voice' | 'upload' | 'stop' }) => void;
  'message:send': (payload: { chatId: ChatId; clientMessageId: string; text: string }, ack?: (res: { ok: boolean; seq?: number; error?: string }) => void) => void;
  'receipt:read': (payload: { chatId: ChatId; upToSeq: number }) => void;
  'call:signal': (payload: { callId: string; to: UserId; kind: 'offer' | 'answer' | 'ice' | 'hangup' | 'invite' | 'accept' | 'decline'; data: unknown }) => void;
  'auth:watch_pending': (payload: { requestId: string }, ack?: (ok: boolean) => void) => void;
  'presence:ping': () => void;
}

export interface InterServerEvents {}
export interface SocketData {
  userId?: UserId;
  sessionId?: string;
}
