import 'dotenv/config';
import { z } from 'zod';

/**
 * 环境变量在启动时一次性校验，缺关键项直接退出——不要等到某个请求才 500。
 * 注意：z.coerce.boolean() 会把字符串 "false" 判成 true，这里用显式白名单解析。
 */
const booleanish = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  }
  return false;
}, z.boolean());

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  CORS_ORIGINS: z.string().default(''),

  DATABASE_URL: z.string().url(),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少 32 字符'),
  JWT_TTL: z.string().default('7d'),

  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  DEEPSEEK_MODEL: z.string().default('deepseek-flash'),
  DEEPSEEK_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  EMBEDDING_BASE_URL: z.string().url(),
  EMBEDDING_API_KEY: z.string().default(''),
  EMBEDDING_MODEL: z.string().default('bge-m3'),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(1024),
  EMBEDDING_BATCH: z.coerce.number().int().positive().default(16),

  WECHAT_APPID: z.string().default(''),
  WECHAT_SECRET: z.string().default(''),
  WECHAT_TEMPLATE_PROACTIVE: z.string().default(''),
  PUBLIC_BASE_URL: z.string().default(''),

  JOB_CONCURRENCY: z.coerce.number().int().positive().default(4),
  HEARTBEAT_INTERVAL_MINUTES: z.coerce.number().int().positive().default(30),
  /** false = 只跑 HTTP 层，队列降级为 no-op（本地验收 / 无 pg-boss 环境用） */
  JOBS_ENABLED: booleanish.default(true),

  COMFYUI_URL: z.string().url().default('http://127.0.0.1:8188'),
  COMFYUI_ENABLED: booleanish.default(false),
  COMFYUI_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  STORAGE_DIR: z.string().default('./var/storage'),
});

const parsed = Env.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`环境变量校验失败，服务不启动：\n${detail}\n\n请对照 .env.example 补齐。`);
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  corsOrigins: raw.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  wechatEnabled: Boolean(raw.WECHAT_APPID && raw.WECHAT_SECRET),
};

export type Env = typeof env;
