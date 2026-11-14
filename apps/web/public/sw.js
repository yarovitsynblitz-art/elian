/* Service worker Элиана: офлайн-оболочка + кэш ассетов. API и медиа не кэшируются надолго. */
const VERSION = 'elian-v2';
const SHELL = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

/** Кладём в кэш index.html и все хэшированные чанки, на которые он ссылается.
 *  Без этого офлайн-оболочка открывается, но без JS — экран остаётся пустым. */
async function precacheShell() {
  const cache = await caches.open(VERSION);
  await Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined)));
  const response = await fetch('/', { cache: 'reload' }).catch(() => null);
  if (!response || !response.ok) return;
  const html = await response.clone().text();
  await cache.put('/', response.clone());
  await cache.put('/index.html', response.clone());
  const assets = Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g), (match) => match[1]);
  await Promise.all(assets.map((url) => cache.add(url).catch(() => undefined)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) return;

  // Навигация: network-first, офлайн — оболочка.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Обновляем оболочку и чанки в фоне, чтобы следующий офлайн-запуск работал.
          if (response.ok) event.waitUntil(precacheShell().catch(() => undefined));
          return response;
        })
        .catch(async () => {
          const cached = (await caches.match('/index.html')) || (await caches.match('/'));
          return cached || new Response('Офлайн: страница не закэширована', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }),
    );
    return;
  }

  // Ассеты: cache-first с обновлением в фоне.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, clone)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

self.addEventListener('push', (event) => {
  let payload = { title: 'Элиан', body: 'Новое сообщение', url: '/' };
  try { payload = { ...payload, ...event.data.json() }; } catch (err) { /* текст */ }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: payload.url || '/' },
      tag: payload.tag || 'elian-message',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(target).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
