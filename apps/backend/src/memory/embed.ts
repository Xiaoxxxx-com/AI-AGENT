import OpenAI from 'openai';
import type { env as appEnv } from '../config.js';

export interface Embedder {
  readonly dim: number;
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbedderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  dim: number;
  batchSize: number;
}

/** 向量写库必须用参数化字符串，不要拼 SQL */
export function toSqlVector(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

export function assertVector(vec: unknown, dim: number, index: number): number[] {
  if (!Array.isArray(vec) || vec.length !== dim) {
    const got = Array.isArray(vec) ? vec.length : typeof vec;
    throw new Error(
      `embedding 维度不一致：第 ${index} 条返回 ${got}，期望 ${dim}。` +
        `检查 EMBEDDING_MODEL 与 EMBEDDING_DIM，换模型必须全量重算。`,
    );
  }
  return vec as number[];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * OpenAI 兼容实现：本地 Ollama（bge-m3）、Xinference、vLLM 或任意云服务都能接。
 * DeepSeek 当前不提供 embedding 接口，所以这一层必须可插拔。
 */
export function createEmbedder(cfg: EmbedderConfig): Embedder {
  const client = new OpenAI({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey || 'not-needed',
    timeout: 60_000,
    maxRetries: 2,
  });

  return {
    dim: cfg.dim,
    model: cfg.model,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += cfg.batchSize) {
        const batch = texts.slice(i, i + cfg.batchSize);
        const res = await client.embeddings.create({ model: cfg.model, input: batch });
        const ordered = [...res.data].sort((x, y) => x.index - y.index);
        if (ordered.length !== batch.length) {
          throw new Error(`embedding 返回条数不匹配：${ordered.length} != ${batch.length}`);
        }
        ordered.forEach((item, idx) => {
          out.push(assertVector(item.embedding, cfg.dim, i + idx));
        });
      }
      return out;
    },
  };
}

export function createEmbedderFromEnv(env: typeof appEnv): Embedder {
  return createEmbedder({
    baseURL: env.EMBEDDING_BASE_URL,
    apiKey: env.EMBEDDING_API_KEY,
    model: env.EMBEDDING_MODEL,
    dim: env.EMBEDDING_DIM,
    batchSize: env.EMBEDDING_BATCH,
  });
}
