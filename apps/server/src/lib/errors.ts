export class AppError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const errors = {
  unauthorized: (msg = 'Требуется вход') => new AppError(401, 'unauthorized', msg),
  forbidden: (msg = 'Недостаточно прав') => new AppError(403, 'forbidden', msg),
  notFound: (msg = 'Не найдено') => new AppError(404, 'not_found', msg),
  badRequest: (msg = 'Некорректный запрос', details?: unknown) => new AppError(400, 'bad_request', msg, details),
  conflict: (msg = 'Конфликт') => new AppError(409, 'conflict', msg),
  tooMany: (msg = 'Слишком много попыток. Попробуйте позже.') => new AppError(429, 'rate_limited', msg),
  internal: (msg = 'Внутренняя ошибка') => new AppError(500, 'internal', msg),
};
