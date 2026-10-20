-- pgvector 与 trigram：drizzle-kit 不会自动生成扩展，必须手写，且要在建表之前执行。
-- 开发环境里 ops/init/001_extensions.sql 已经建过，这里 IF NOT EXISTS 保持幂等。
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
