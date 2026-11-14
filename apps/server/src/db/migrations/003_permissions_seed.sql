-- Каталог прав (используется для валидации JSON-прав и отображения в UI).
INSERT INTO permissions(key, description) VALUES
  ('sendMessages', 'Отправка сообщений'),
  ('sendMedia', 'Отправка медиа'),
  ('inviteUsers', 'Приглашение участников'),
  ('pinMessages', 'Закрепление сообщений'),
  ('manageMessages', 'Удаление/редактирование чужих сообщений'),
  ('banUsers', 'Блокировка участников'),
  ('muteUsers', 'Мьют участников'),
  ('manageInvites', 'Управление ссылками-приглашениями'),
  ('manageChat', 'Изменение настроек чата'),
  ('anonymous', 'Анонимная отправка от имени чата')
ON CONFLICT(key) DO UPDATE SET description = excluded.description;
