import { EventEmitter } from 'node:events';
import type { ChatSummary, Message, PendingStatus } from '@elian/shared';

export interface BusEvents {
  'pending:created': { requestId: string };
  'pending:changed': { requestId: string; status: PendingStatus };
  'message:new': { chatId: string; message: Message; chat: ChatSummary };
  'session:revoked': { userId: string; sessionId: string };
  'bot:update': { botId: string };
}

class TypedBus extends EventEmitter {
  emitEvent<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    this.emit(event, payload);
  }
  onEvent<K extends keyof BusEvents>(event: K, handler: (payload: BusEvents[K]) => void): () => void {
    this.on(event, handler as (...args: unknown[]) => void);
    return () => this.off(event, handler as (...args: unknown[]) => void);
  }
}

export const bus = new TypedBus();
bus.setMaxListeners(50);
