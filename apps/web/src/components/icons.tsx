import type { SVGProps } from 'react';

/** Собственный набор иконок Элиана (контурные, 24×24). */
const paths: Record<string, string> = {
  chat: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 21l1.9-4.9A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z',
  users: 'M17 20v-1.5A3.5 3.5 0 0 0 13.5 15h-5A3.5 3.5 0 0 0 5 18.5V20M11 11.5A3.5 3.5 0 1 0 11 4.5a3.5 3.5 0 0 0 0 7ZM17.5 4.6a3.5 3.5 0 0 1 0 6.8M19 20v-1.5a3.5 3.5 0 0 0-2.5-3.3',
  settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.4-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z',
  search: 'M17 17l3.5 3.5M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  plus: 'M12 5v14M5 12h14',
  'arrow-left': 'M19 12H5M11 18l-6-6 6-6',
  'arrow-down': 'M12 5v14M6 13l6 6 6-6',
  send: 'M4 12 20 4l-8 16-2-6-6-2Z',
  mic: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3ZM5 11a7 7 0 0 0 14 0M12 18v3',
  paperclip: 'M20 11.5 12 19.5a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9 10h.01M15 10h.01M8.5 14.5a4.5 4.5 0 0 0 7 0',
  more: 'M12 6.5h.01M12 12h.01M12 17.5h.01',
  check: 'M5 13l4 4L19 7',
  'check-double': 'M2 12.5 6 17 14 7M10 15l3 3 9-11',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3.5 2',
  pin: 'M12 17v5M8 3h8l-1 6 3 3H6l3-3-1-6Z',
  reply: 'M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6v1',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  forward: 'M14 7l5 5-5 5M19 12H9a5 5 0 0 0-5 5v1',
  close: 'M6 6l12 12M18 6 6 18',
  camera: 'M4 8h3l1.5-2h7L17 8h3v11H4V8ZM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  phone: 'M6.5 3.5h3l1.5 4-2 1.5a10 10 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5Z',
  'phone-off': 'M6.5 3.5h3l1.5 4-2 1.5a10 10 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5ZM3 3l18 18',
  video: 'M4 7h10v10H4zM14 10l6-3v10l-6-3',
  'video-off': 'M4 7h10v10H4zM14 10l6-3v10l-6-3M3 3l18 18',
  'mic-off': 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3ZM5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18',
  'screen-share': 'M3 5h18v11H3zM8 20h8M12 16v4',
  logout: 'M9 21H5V3h4M16 17l5-5-5-5M21 12H9',
  shield: 'M12 21s7-3.5 7-9V6l-7-3-7 3v6c0 5.5 7 9 7 9Z',
  bell: 'M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7M13.7 20a2 2 0 0 1-3.4 0',
  palette: 'M12 21a9 9 0 1 1 0-18c5 0 9 3.5 9 8 0 2.5-2 4-4 4h-2a2 2 0 0 0-1 3.7A2 2 0 0 1 12 21ZM7.5 11h.01M10 7.5h.01M14 7.5h.01M16.5 11h.01',
  folder: 'M3 7h6l2 2h10v10H3z',
  database: 'M12 8c4.4 0 8-1.1 8-2.5S16.4 3 12 3 4 4.1 4 5.5 7.6 8 12 8ZM4 5.5v13C4 19.9 7.6 21 12 21s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.4 4 5.6 4 9s-1.5 6.6-4 9c-2.5-2.4-4-5.6-4-9s1.5-6.6 4-9Z',
  devices: 'M3 6h12v9H3zM9 19h4M17 10h4v9h-4z',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19',
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
  download: 'M12 3v12M7 11l5 5 5-5M4 21h16',
  image: 'M3 5h18v14H3zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM21 16l-5-5-9 8',
  file: 'M14 3H7v18h10V8zM14 3v5h3',
  play: 'M8 5l11 7-11 7V5Z',
  pause: 'M8 5v14M16 5v14',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v6M12 7.5h.01',
  lock: 'M6 11h12v10H6zM9 11V8a3 3 0 0 1 6 0v3',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  'eye-off': 'M3 3l18 18M10.6 6.2A9.6 9.6 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.8M6.5 7.5A17 17 0 0 0 2 12s3.5 6 10 6c1.3 0 2.5-.2 3.6-.6',
  'user-plus': 'M15 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-4A3.5 3.5 0 0 0 4 18.5V20M10 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM18 8v6M15 11h6',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
  archive: 'M3 7h18v13H3zM2 3h20v4H2zM9 12h6',
  'volume-x': 'M11 5 6 9H3v6h3l5 4V5ZM16 9l5 6M21 9l-5 6',
  'pin-off': 'M12 17v5M8 3h8l-1 6 3 3H6l3-3-1-6ZM3 3l18 18',
  story: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 8v8M8 12h8',
  heart: 'M12 20s-7-4.3-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.7-7 9-7 9Z',
  sticker: 'M12 3h4l5 5v9a3 3 0 0 1-3 3H9a5 5 0 0 1-5-5V8a5 5 0 0 1 5-5h3ZM16 3v5h5M9 14h.01M14.5 14h.01M9.5 17c1.5.7 3.5.7 5 0',
  poll: 'M6 20V10M12 20V4M18 20v-7',
  users2: 'M8 18v-1a4 4 0 0 1 8 0v1M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4 18v-1a3 3 0 0 1 3-3M6.5 8.5a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM20 18v-1a3 3 0 0 0-3-3M17.5 8.5a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z',
  bot: 'M7 9h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2ZM12 5v4M9.5 14h.01M14.5 14h.01M2 13v2M22 13v2',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  sparkle: 'M12 3l1.8 4.9L19 9.7l-4.6 2.6L12 18l-2.4-5.7L5 9.7l5.2-1.8L12 3Z',
  delete: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  'log-out': 'M15 3h4v18h-4M10 17l5-5-5-5M15 12H3',
};

export interface IconProps extends SVGProps<SVGSVGElement> {
  name: keyof typeof paths | string;
  size?: number;
  filled?: boolean;
}

export function Icon({ name, size = 20, filled = false, ...rest }: IconProps) {
  const d = paths[name] ?? paths.chat;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={d} />
    </svg>
  );
}

export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-label="Элиан" role="img">
      <defs>
        <linearGradient id="elian-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5C49FF" />
          <stop offset="100%" stopColor="#2A1F8F" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#elian-logo)" />
      <path d="M24 12c-6.6 0-12 4.6-12 10.3 0 3.2 1.7 6 4.4 7.9v5.2l5-2.9c.8.1 1.7.2 2.6.2 6.6 0 12-4.6 12-10.4S30.6 12 24 12Z" fill="#fff" />
      <path d="M31.2 27.4c.5-1.1 1.6-1.7 2.7-1.3-.2 2.6-1.9 4.6-4.4 5.3l.4-2.4c.2-1 .6-1.9 1.3-2.6Z" fill="#12C2B4" />
    </svg>
  );
}
