import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@elian/shared';

export type ElianSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: ElianSocket | null = null;

export function getSocket(): ElianSocket {
  if (!socket) {
    socket = io(window.location.origin, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 8000,
      autoConnect: false,
    });
  }
  return socket;
}

export function connectSocket(pendingSecret?: string): ElianSocket {
  const instance = getSocket();
  if (pendingSecret) instance.auth = { pendingSecret };
  if (!instance.connected) instance.connect();
  return instance;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
