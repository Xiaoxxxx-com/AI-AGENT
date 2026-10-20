-- 容器首次初始化时执行（pgvector/pgvector:pg17 自带 vector，pg_trgm 为内置 contrib）
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
