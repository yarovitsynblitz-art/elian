import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { CallInfo, PublicUser } from '@elian/shared';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';
import { useAppStore } from '../store/app';
import { Avatar, Button } from './ui';
import { Icon } from './icons';

/**
 * 1:1 звонок: сигнализация через Socket.IO, медиа — WebRTC.
 * Групповые звонки требуют внешнего SFU (см. docs/LIMITATIONS.md).
 */
export function CallScreen() {
  const { media = 'audio', peerId } = useParams<{ media: 'audio' | 'video'; peerId: string }>();
  const navigate = useNavigate();
  const me = useAppStore((state) => state.user);
  const toast = useAppStore((state) => state.toast);
  const [callId, setCallId] = useState<string | null>(null);
  const [peer, setPeer] = useState<Partial<PublicUser> | null>(null);
  const [status, setStatus] = useState<'calling' | 'connecting' | 'active' | 'ended' | 'error'>('calling');
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(media === 'audio');
  const [errorText, setErrorText] = useState<string | null>(null);
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callIdRef = useRef<string | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>([]);

  const cleanup = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
  }, []);

  const endCall = useCallback(async (reason: 'hangup' | 'decline' | 'ice_failed' | 'no_turn' = 'hangup') => {
    const id = callIdRef.current;
    setStatus('ended');
    cleanup();
    if (id) await api.post(`/calls/${id}/end`, { reason }).catch(() => undefined);
    setTimeout(() => navigate(-1), 900);
  }, [cleanup, navigate]);

  const buildPeerConnection = useCallback(async () => {
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
    pcRef.current = pc;
    const stream = localStreamRef.current;
    stream?.getTracks().forEach((track) => pc.addTrack(track, stream));
    pc.onicecandidate = (event) => {
      if (event.candidate && callIdRef.current && peerId) {
        getSocket().emit('call:signal', { callId: callIdRef.current, to: peerId ?? '', kind: 'ice', data: event.candidate.toJSON() });
      }
    };
    pc.ontrack = (event) => {
      if (remoteRef.current) remoteRef.current.srcObject = event.streams[0] ?? null;
      setStatus('active');
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        setErrorText('Не удалось установить соединение. Возможно, нужен TURN-сервер.');
        void endCall('ice_failed');
      }
    };
    return pc;
  }, [endCall, peerId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await api.get<{ iceServers: RTCIceServer[]; turnConfigured: boolean; warning: string | null }>('/calls/config');
        iceServersRef.current = config.iceServers;
        if (!config.turnConfigured) toast('TURN не настроен — звонок может не соединиться в некоторых сетях', 'info');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: media === 'video' });
        if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
        localStreamRef.current = stream;
        if (localRef.current) localRef.current.srcObject = stream;
        const call = await api.post<{ call: CallInfo }>('/calls', { peerId, media });
        if (cancelled) return;
        callIdRef.current = call.call.id;
        setCallId(call.call.id);
        setPeer(call.call.peer ?? null);
      } catch (error) {
        setStatus('error');
        setErrorText((error as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [media, peerId, toast, cleanup]);

  useEffect(() => {
    const socket = getSocket();
    const onSignal = async ({ callId: incomingCallId, kind, data }: { callId: string; kind: string; data: unknown }) => {
      if (incomingCallId !== callIdRef.current) return;
      try {
        if (kind === 'answer') {
          await pcRef.current?.setRemoteDescription(new RTCSessionDescription(data as RTCSessionDescriptionInit));
          setStatus('connecting');
        } else if (kind === 'offer') {
          const pc = pcRef.current ?? (await buildPeerConnection());
          await pc.setRemoteDescription(new RTCSessionDescription(data as RTCSessionDescriptionInit));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('call:signal', { callId: incomingCallId, to: peerId ?? '', kind: 'answer', data: answer });
          setStatus('connecting');
        } else if (kind === 'ice') {
          await pcRef.current?.addIceCandidate(new RTCIceCandidate(data as RTCIceCandidateInit));
        }
      } catch (error) {
        setErrorText((error as Error).message);
      }
    };
    const onState = (payload: CallInfo & { id: string }) => {
      if (payload.id !== callIdRef.current) return;
      if (payload.status === 'active') setStatus('connecting');
      if (payload.status === 'ended' || payload.status === 'declined' || payload.status === 'missed' || payload.status === 'failed') {
        setStatus('ended');
        cleanup();
        setTimeout(() => navigate(-1), 900);
      }
    };
    socket.on('call:signal', onSignal);
    socket.on('call:state', onState);
    return () => {
      socket.off('call:signal', onSignal);
      socket.off('call:state', onState);
      return undefined;
    };
  }, [buildPeerConnection, cleanup, navigate, peerId]);

  // Инициатор: после ответа собеседника создаём offer.
  useEffect(() => {
    if (status !== 'connecting' || !callId) return;
    (async () => {
      try {
        const pc = pcRef.current ?? (await buildPeerConnection());
        if (pc.signalingState !== 'stable') return;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        getSocket().emit('call:signal', { callId, to: peerId ?? '', kind: 'offer', data: offer });
      } catch (error) {
        setErrorText((error as Error).message);
      }
    })();
  }, [status, callId]);

  useEffect(() => {
    if (status !== 'active') return;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);

  function toggleMute() {
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = muted; });
    setMuted((value) => !value);
  }

  function toggleCamera() {
    localStreamRef.current?.getVideoTracks().forEach((track) => { track.enabled = cameraOff; });
    setCameraOff((value) => !value);
  }

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-[#0b0a12] text-white">
      <div className="flex items-center gap-3 px-4 pt-6">
        <Icon name={media === 'video' ? 'video' : 'phone'} size={18} className="text-white/60" />
        <div>
          <div className="text-sm font-semibold">{peer?.displayName ?? 'Звонок'}</div>
          <div className="text-[11px] text-white/60">
            {status === 'calling' ? 'Вызываем…' : status === 'connecting' ? 'Соединяем…' : status === 'active'
              ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
              : status === 'ended' ? 'Звонок завершён' : 'Ошибка'}
          </div>
        </div>
      </div>

      <div className="relative flex flex-1 items-center justify-center p-4">
        {media === 'video' ? (
          <>
            <video ref={remoteRef} autoPlay playsInline className="h-full max-h-[70vh] w-full rounded-xl3 bg-black object-contain" />
            <video ref={localRef} autoPlay playsInline muted className="absolute bottom-4 right-4 h-32 w-24 rounded-xl2 border border-white/20 object-cover" />
          </>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <Avatar name={peer?.displayName ?? '?'} src={peer?.avatarUrl ?? null} size={112} />
            <audio ref={remoteRef as unknown as React.RefObject<HTMLAudioElement>} autoPlay />
            {errorText ? <p className="max-w-xs text-center text-xs text-white/60">{errorText}</p> : null}
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-3 pb-10">
        <button className={`call-btn ${muted ? 'bg-white text-black' : 'bg-white/15'}`} onClick={toggleMute} aria-label="Микрофон">
          <Icon name={muted ? 'mic-off' : 'mic'} />
        </button>
        {media === 'video' ? (
          <button className={`call-btn ${cameraOff ? 'bg-white text-black' : 'bg-white/15'}`} onClick={toggleCamera} aria-label="Камера">
            <Icon name={cameraOff ? 'video-off' : 'video'} />
          </button>
        ) : null}
        <button className="call-btn bg-danger text-white" onClick={() => void endCall('hangup')} aria-label="Завершить">
          <Icon name="phone-off" />
        </button>
      </div>
    </div>
  );
}

/** Входящий звонок: всплывает поверх интерфейса. */
export function IncomingCallBanner() {
  const [incoming, setIncoming] = useState<CallInfo | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const socket = getSocket();
    const onState = (payload: CallInfo & { id: string }) => {
      if (payload.status === 'ringing' && payload.direction === 'incoming') setIncoming(payload);
      if (payload.status !== 'ringing') setIncoming(null);
    };
    socket.on('call:state', onState);
    return () => {
      socket.off('call:state', onState);
      return undefined;
    };
  }, []);
  if (!incoming) return null;
  return (
    <div className="fixed inset-x-3 top-3 z-[85] flex items-center gap-3 rounded-xl2 border border-line bg-surface p-3 shadow-2xl animate-slide-up">
      <Avatar name={incoming.peer?.displayName ?? '?'} src={incoming.peer?.avatarUrl ?? null} size={40} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{incoming.peer?.displayName ?? 'Входящий звонок'}</div>
        <div className="text-[11px] text-ink-muted">{incoming.media === 'video' ? 'Видеозвонок' : 'Аудиозвонок'}</div>
      </div>
      <Button size="sm" variant="ghost" onClick={async () => {
        await api.post(`/calls/${incoming.id}/end`, { reason: 'decline' }).catch(() => undefined);
        setIncoming(null);
      }}>Отклонить</Button>
      <Button size="sm" onClick={() => { navigate(`/call/${incoming.media}/${incoming.peer?.id}`); setIncoming(null); }}>Ответить</Button>
    </div>
  );
}
