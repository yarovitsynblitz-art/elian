import { canSend, type ChatRow, type MemberRow } from './chats.js';
export { insertMessage, serializeMessage, markRead, markDelivered, getMessageRow } from './messages.js';

export function canSendHelper(chat: ChatRow, member: MemberRow): boolean {
  return canSend(chat, member, 'text');
}
