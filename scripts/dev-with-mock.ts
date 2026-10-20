/**
 * 本地无 Key 启动：把 LLM / Embedding 都指向本地 mock。
 *
 *   pnpm mock:llm           # 窗口 1
 *   pnpm dev:mock           # 窗口 2
 *
 * .env 里已有的值优先，所以接真实 DeepSeek 时把 DEEPSEEK_API_KEY 填上、
 * 并用常规的 pnpm dev 即可，不受这里影响。
 */
process.env.DEEPSEEK_BASE_URL ??= 'http://127.0.0.1:4010/v1';
process.env.EMBEDDING_BASE_URL ??= 'http://127.0.0.1:4010/v1';
process.env.DEEPSEEK_API_KEY ??= 'mock-key';
process.env.EMBEDDING_API_KEY ??= 'mock-key';

// 注意：.env 由 config.ts 里的 dotenv 读取，且不会覆盖已存在的环境变量，
// 所以上面这三个 ??= 之后，dotenv 不会把 baseURL 改回 https://api.deepseek.com
await import('../apps/backend/src/server.js');
