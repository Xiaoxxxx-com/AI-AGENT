/**
 * 用 WASM 版数据库（PGlite）起开发服务。
 *
 *   终端 1: pnpm pg:wasm
 *   终端 2: pnpm dev:wasm          # 数据库用 5433，模型用 .env 里的真实配置
 *
 * 为什么要它：原生 PostgreSQL 起不来的环境（无 Docker / initdb 被拦）里，
 * 仍然需要一个能跑的数据库。这里只覆盖数据库和队列，**不动模型配置**——
 * 你在 .env 里填了真实 DeepSeek key，走这个脚本就是真实模型。
 *
 * 想在没有 key 的情况下跑通链路：
 *   pnpm mock:llm  +  pnpm dev:wasm:mock
 */
const USE_MOCK = process.argv.includes('--mock') || process.env.MOCK_LLM === '1';

process.env.DATABASE_URL ??= 'postgres://companion:companion_dev@127.0.0.1:5433/companion';
// PGlite 不支持 pg-boss 依赖的 advisory lock + NOTIFY 组合
process.env.JOBS_ENABLED = 'false';

if (USE_MOCK) {
  process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:4010/v1';
  process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:4010/v1';
  process.env.DEEPSEEK_API_KEY ??= 'mock-key';
  process.env.EMBEDDING_API_KEY ??= 'mock-key';
}

console.log(
  `[dev:wasm] DB=5433 · JOBS_ENABLED=false · 模型=${USE_MOCK ? '本地 mock（4010）' : '.env 里的真实配置'}`,
);

await import('../apps/backend/src/server.js');
