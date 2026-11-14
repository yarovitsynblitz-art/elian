# API Элиана

Базовый префикс: `GET /api/v1/...` (OpenAPI 3: `GET /api/v1/openapi.json`, человекочитаемая схема — там же).

## Аутентификация

1. `GET /api/v1/auth/csrf` — получить CSRF-cookie (double-submit).
2. `POST /api/v1/auth/register` `{username, displayName, password}` → `202 {status:"pending", requestId, approvalSecret, expiresAt}`.
   Код подтверждения клиенту **не** возвращается никогда.
3. Владелец подтверждает в консоли Termux: `y`.
4. `POST /api/v1/auth/pending/status` `{requestId, approvalSecret}` → `{status}` (`pending|approved|rejected|expired`).
5. `POST /api/v1/auth/pending/exchange-registration` `{requestId, approvalSecret}` → сессия (cookie) + `{user}`.

Вход: `POST /auth/login` → заявка → `y` → `POST /auth/pending/exchange`.
Сброс: клиент генерирует `clientSecret` (≥24 симв.) → `POST /auth/reset {username, clientSecret}` →
`POST /auth/reset/status {clientSecret}` (опрос) → после `y` → `POST /auth/pending/exchange-reset` → `{resetTicket}` →
`POST /auth/reset/complete {ticket, newPassword}`.

Все мутирующие запросы требуют заголовок `x-csrf-token` со значением cookie `elian_csrf`.

## Основные группы

| Группа | Примеры |
|---|---|
| Профиль | `GET/PATCH /me`, `POST /me/username`, `POST /me/avatar`, `GET/PATCH /me/settings`, `GET /me/sessions` |
| 2FA | `POST /me/tfa/setup`, `POST /me/tfa/enable`, `POST /me/tfa/disable` |
| Чаты | `GET /chats`, `POST /chats`, `POST /chats/private`, `PATCH /chats/:id`, `GET /chats/:id/members`, `POST /chats/:id/members`, `POST /chats/:id/invites`, `POST /join/:token` |
| Сообщения | `GET/POST /chats/:id/messages`, `PATCH /messages/:id`, `DELETE /messages/:id`, `POST /messages/:id/reactions`, `POST /messages/:id/pin`, `POST /messages/forward`, `POST /polls/:id/vote` |
| Медиа | `POST /media/upload` (multipart), `GET /media/:id/content` (Range), `GET /media/:id/thumbnail`, `GET /media/:id/download` |
| Поиск | `GET /search?q=`, `GET /search/users?q=`, `GET /chats/:id/search?q=` |
| Истории | `GET/POST /stories`, `POST /stories/:id/view`, `POST /stories/:id/reaction`, `GET /stories/archive/list` |
| Звонки | `GET /calls/config`, `POST /calls`, `POST /calls/:id/answer`, `POST /calls/:id/end`, `GET /calls/history` |
| Боты | `POST /bots`, `PATCH /bots/:id`, `POST /bots/:id/token`, `POST /bots/:username/invoke` |
| Админ (владелец) | `GET /admin/reports`, `GET /admin/audit`, `GET /admin/metrics` |

## Socket.IO

Путь `/socket.io`, авторизация — та же cookie-сессия.

Клиент → сервер: `chat:subscribe`, `chat:unsubscribe`, `typing`, `receipt:read`, `message:send`, `call:signal`, `presence:ping`, `auth:watch_pending`.
Сервер → клиент: `message:new`, `message:edited`, `message:deleted`, `reaction:changed`, `chat:updated`, `chat:removed`,
`typing`, `receipt`, `presence`, `call:state`, `call:signal`, `auth:pending_status`, `auth:session_revoked`, `error`.

Доставка персональная (`user:<id>`): сообщение приходит всем участникам чата независимо от того, открыт ли чат,
а `isOutgoing`/`byMe` считаются индивидуально.

## Ошибки

```json
{ "error": "validation_error", "message": "Проверьте правильность заполнения полей", "details": [...], "requestId": "..." }
```
Коды: `unauthorized`, `forbidden`, `not_found`, `validation_error`, `rate_limited`, `csrf_failed`, `bad_origin`,
`pending`, `tfa_required`, `internal_error`.
