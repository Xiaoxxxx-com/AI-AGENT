-- 仅当你的库**已经有** users / notes / tags / note_tags（并且类型是 BIGINT 主键）时使用这个脚本，
-- 不要再跑 drizzle 的 0001_init。执行顺序：
--   1) 先跑 0000_extensions.sql
--   2) 再跑本脚本
--   3) 最后跑 0002_vector_index.sql 与其余新表（user_insights / companion_state / proactive_log /
--      conversation_summaries / conversations）的 DDL，可从 0001_init.sql 里挑出这几张表执行
--
-- 执行前务必：pg_dump 备份。ALTER 加带默认值的 NOT NULL 列在大表上会锁表，个人项目可忽略。

-- ===== users 补列 =====
ALTER TABLE users ADD COLUMN IF NOT EXISTS wechat_openid TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS unionid TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai';
ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_start TIME NOT NULL DEFAULT '23:00';
ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_end TIME NOT NULL DEFAULT '08:00';
ALTER TABLE users ADD COLUMN IF NOT EXISTS proactive_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_proactive_cap INT NOT NULL DEFAULT 3;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_quota INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ===== notes 补列 =====
-- content_tokens 由应用写入（jieba 分词结果），生成列才能正确切词
ALTER TABLE notes ADD COLUMN IF NOT EXISTS content_tokens TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS content_tsvector TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content_tokens, ''))) STORED;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS embedding vector(1024);
ALTER TABLE notes ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMPTZ;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_notes_user_time ON notes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_tsvector ON notes USING gin (content_tsvector);

-- ===== conversations 原来是 messages 表的话，需要这个视图对齐列名 =====
-- CREATE VIEW conversations AS SELECT id, user_id, role, content, created_at FROM messages;
