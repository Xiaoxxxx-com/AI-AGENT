/**
 * 用 WASM 版数据库（PGlite）起开发服务。
 *
 *   终端 1: pnpm pg:wasm      # 5433
 *   终端 2: pnpm dev:wasm     # 本脚本
 *
 * 适用于原生 PostgreSQL 起不来的环境。JOBS_ENABLED 会被强制关掉——
 * PGlite 不支持 pg-boss 依赖的 advisory lock + NOTIFY 组合，
 * 所以心跳/摘要/反思这些定时任务在 WASM 模式下不会跑（接口本身都正常）。
 *
 * 已经配好真实 .env 的话直接用 pnpm dev，不要用这个。
 */
process.env.DATABASE_URL ??= 'postgres://companion:companion_dev@127.0.0.1:5433/companion';
process.env.JOBS_ENABLED = 'false';
process.env.DEEPSEEK_BASE_URL ??= 'http://127.0.0.1:4010/v1';
process.env.EMBEDDING_BASE_URL ??= 'http://127.0.0.1:4010/v1';
process.env.DEEPSEEK_API_KEY ??= 'mock-key';
process.env.EMBEDDING_API_KEY ??= 'mock-key';

console.log('[dev:wasm] DATABASE_URL=5433 · JOBS_ENABLED=false · LLM/Embedding 走本地 mock');
await import('../apps/backend/src/server.js');
