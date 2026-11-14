/** Минимальная, но валидная OpenAPI 3.1-схема основных маршрутов. */
export function openapiDocument(): Record<string, unknown> {
  const json = { 'application/json': { schema: { type: 'object' } } };
  const ok = { description: 'Успешно', content: json };
  const auth = [{ cookieAuth: [] }];
  return {
    openapi: '3.1.0',
    info: {
      title: 'Elian API',
      version: '1.0.0',
      description: 'REST + Socket.IO API мессенджера «Элиан». Авторизация: HttpOnly cookie `elian_session` + заголовок `x-csrf-token`.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'elian_session' },
        botToken: { type: 'apiKey', in: 'path', name: 'token' },
      },
      schemas: {
        ApiError: {
          type: 'object',
          properties: { error: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' } },
        },
        PendingResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending'] },
            requestId: { type: 'string', format: 'uuid' },
            approvalSecret: { type: 'string', description: 'Секрет клиента для опроса статуса. Код подтверждения сюда не попадает.' },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        SelfUser: { type: 'object', properties: { id: { type: 'string' }, username: { type: 'string' }, displayName: { type: 'string' } } },
        Message: { type: 'object', properties: { id: { type: 'string' }, chatId: { type: 'string' }, seq: { type: 'integer' }, text: { type: 'string' } } },
      },
    },
    paths: {
      '/auth/register': {
        post: {
          summary: 'Начать регистрацию (создаёт заявку владельцу)',
          requestBody: { content: json, required: true },
          responses: { '202': { description: 'Ожидает подтверждения владельца', content: { 'application/json': { schema: { $ref: '#/components/schemas/PendingResponse' } } } }, '400': { $ref: '#/components/responses/BadRequest' } },
        },
      },
      '/auth/login': {
        post: { summary: 'Вход: проверка Argon2id, затем заявка владельцу', requestBody: { content: json, required: true }, responses: { '202': { description: 'Ожидает подтверждения' }, '401': { description: 'Неверный логин или пароль / требуется TOTP' } } },
      },
      '/auth/pending/status': {
        post: { summary: 'Статус заявки (по requestId + approvalSecret)', requestBody: { content: json, required: true }, responses: { '200': ok } },
      },
      '/auth/pending/exchange': {
        post: { summary: 'Обменять подтверждённую заявку LOGIN на сессию', requestBody: { content: json, required: true }, responses: { '200': ok } },
      },
      '/auth/pending/exchange-registration': {
        post: { summary: 'Обменять подтверждённую заявку REGISTRATION на аккаунт + сессию', requestBody: { content: json, required: true }, responses: { '200': ok } },
      },
      '/auth/pending/exchange-reset': {
        post: { summary: 'Получить тикет сброса пароля после подтверждения владельцем', requestBody: { content: json, required: true }, responses: { '200': ok } },
      },
      '/auth/reset': { post: { summary: 'Запросить сброс (ответ не раскрывает существование аккаунта)', requestBody: { content: json, required: true }, responses: { '202': ok } } },
      '/auth/reset/complete': { post: { summary: 'Завершить сброс с тикетом и новым паролем', requestBody: { content: json, required: true }, responses: { '200': ok } } },
      '/auth/logout': { post: { summary: 'Выход', security: auth, responses: { '200': ok } } },
      '/auth/me': { get: { summary: 'Текущий пользователь', security: auth, responses: { '200': ok } } },
      '/chats': { get: { summary: 'Список чатов', security: auth, responses: { '200': ok } }, post: { summary: 'Создать группу/канал', security: auth, responses: { '201': ok } } },
      '/chats/{id}/messages': {
        get: { summary: 'История сообщений (пагинация по seq)', security: auth, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': ok } },
        post: { summary: 'Отправить сообщение', security: auth, responses: { '201': ok } },
      },
      '/media/upload': { post: { summary: 'Загрузка файла (multipart, шифруется AES-256-GCM)', security: auth, responses: { '201': ok } } },
      '/media/{id}/content': { get: { summary: 'Отдача файла (Range поддерживается)', security: auth, responses: { '200': { description: 'Файл' } } } },
      '/search': { get: { summary: 'Глобальный поиск', security: auth, responses: { '200': ok } } },
      '/calls/config': { get: { summary: 'ICE-серверы и предупреждение о TURN', security: auth, responses: { '200': ok } } },
      '/health': { get: { summary: 'Healthcheck без секретов', responses: { '200': ok } } },
    },
    'x-elian-notes': {
      pending: 'Код подтверждения виден только владельцу в Termux и никогда не возвращается клиенту.',
      csrf: 'Все cookie-мутации требуют заголовок x-csrf-token, равный cookie elian_csrf.',
      bots: 'Bot API по пути /bot/{token}/… не совместим с Telegram Bot API.',
    },
  };
}
