-- HNSW 与 GIN 索引：Drizzle 对 hnsw 的支持随版本变化，直接写 SQL 最稳。
-- 个人数据量（<10 万）用默认参数即可；数据 >50 万再调 m / ef_construction。
--
-- 生产环境大数据量建索引请用 CREATE INDEX CONCURRENTLY（不能在事务里跑），
-- 单独用 psql 执行；drizzle-kit migrate 在事务中执行，个人项目直接建没问题。

-- 只在有向量的行上建索引，避免 NULL 占位把索引撑大
CREATE INDEX IF NOT EXISTS "idx_notes_embedding"
  ON "notes" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE "embedding" IS NOT NULL;
--> statement-breakpoint

-- content_tsvector 的 GIN 索引在 0001_init 里已随 schema 生成；这里补一条兜底，
-- 防止有人从旧库迁移过来时漏掉。
CREATE INDEX IF NOT EXISTS "idx_notes_tsvector"
  ON "notes" USING gin ("content_tsvector");
--> statement-breakpoint

-- 兜底模糊匹配（中文分词缺失时的降级路径），需要 pg_trgm
CREATE INDEX IF NOT EXISTS "idx_notes_content_trgm"
  ON "notes" USING gin ("content" gin_trgm_ops);
