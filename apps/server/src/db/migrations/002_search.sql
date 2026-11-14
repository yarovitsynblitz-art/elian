-- Полнотекстовый поиск (FTS5, unicode61 — корректно работает с русским и английским).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED,
  chat_id UNINDEXED,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
WHEN new.text <> '' AND new.deleted_at IS NULL
BEGIN
  INSERT INTO messages_fts(message_id, chat_id, body) VALUES (new.id, new.chat_id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF text, deleted_at ON messages
BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts(message_id, chat_id, body)
  SELECT new.id, new.chat_id, new.text WHERE new.text <> '' AND new.deleted_at IS NULL;
END;

CREATE INDEX IF NOT EXISTS idx_chats_type ON chats(type, is_public);
CREATE INDEX IF NOT EXISTS idx_messages_chat_pinned ON messages(chat_id, pinned);
