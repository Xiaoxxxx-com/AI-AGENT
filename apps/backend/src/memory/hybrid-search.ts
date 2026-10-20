import type { Pool, PoolClient } from 'pg';
import type { Pool as AppPool } from '../db/client.js';
import { toTsQuery, tokenize } from './segment.js';
import { toSqlVector } from './embed.js';

export type HitSource = 'vector' | 'keyword' | 'both';

export interface SearchHit {
  id: number;
  title: string;
  content: string;
  score: number;
  source: HitSource;
}

export interface HybridSearchOptions {
  userId: number;
  query: string;
  /** 没有 embedding 服务时传 null，自动退化为纯关键词 */
  queryVec: number[] | null;
  topK?: number;
  /** 单路候选数，默认 40。语料小于它时两路会完全重合，「关键词独有命中」指标会失真 */
  candidateLimit?: number;
  efSearch?: number;
}

const RRF_K = 60;

export interface Fused {
  id: number;
  score: number;
  fromVector: boolean;
  fromKeyword: boolean;
}

/**
 * RRF：score = Σ 1 / (k + rank)。
 * 抽成纯函数：一是好测（方案 §8.2 要求覆盖 RRF 分数），
 * 二是把「融合」与「取数」解耦，两路怎么取数可以分别优化。
 */
export function fuseRrf(vectorIds: number[], keywordIds: number[], k = RRF_K): Fused[] {
  const acc = new Map<number, Fused>();

  vectorIds.forEach((id, index) => {
    acc.set(id, { id, score: 1 / (k + index + 1), fromVector: true, fromKeyword: false });
  });

  keywordIds.forEach((id, index) => {
    const add = 1 / (k + index + 1);
    const existing = acc.get(id);
    if (existing) {
      existing.score += add;
      existing.fromKeyword = true;
    } else {
      acc.set(id, { id, score: add, fromVector: false, fromKeyword: true });
    }
  });

  return [...acc.values()].sort((a, b) => b.score - a.score || b.id - a.id);
}

function toSource(f: Fused): HitSource {
  if (f.fromVector && f.fromKeyword) return 'both';
  return f.fromVector ? 'vector' : 'keyword';
}

async function vectorCandidates(
  client: PoolClient,
  userId: number,
  queryVec: number[],
  limit: number,
): Promise<number[]> {
  const { rows } = await client.query<{ id: string }>(
    `select id from notes
     where user_id = $1 and embedding is not null
     order by embedding <=> $2::vector
     limit $3`,
    [userId, toSqlVector(queryVec), limit],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * 关键词路：tsquery 与 pg_trgm 并联，而不是「一个失败才用另一个」。
 *
 * 原因：中文分词是精确 token 匹配，"睡不着" 与原文 "睡着" 不共享 token，
 * 但字符三元组能兜住一部分；两路并联后按 tsquery 优先、trigram 补充排序。
 * trigram 用整句相似度，阈值放宽到 0.08（中文短查询对长文本天然偏低）。
 */
async function keywordCandidates(
  client: PoolClient,
  userId: number,
  query: string,
  limit: number,
): Promise<{ ids: number[]; via: 'tsquery' | 'trigram' | 'none' }> {
  const tsQuery = toTsQuery(query);
  const { rows } = await client.query<{ id: string }>(
    `select n.id, ts_rank_cd(n.content_tsvector, q.ts) as r
     from notes n, (select to_tsquery('simple', $2) as ts) q
     where n.user_id = $1 and n.content_tsvector @@ q.ts
     -- ts_rank_cd 经常打平（都是 0.1），打平时用整句相似度兜底排序，
     -- 否则 id 顺序会变成任意噪声，融合时抢走不该有的分数
     order by r desc, similarity(n.content, $4) desc, n.id desc
     limit $3`,
    [userId, tsQuery, limit, query],
  );
  const tsIds = rows.map((r) => Number(r.id));

  await client.query('SET LOCAL pg_trgm.similarity_threshold = 0.08');
  const fallback = await client.query<{ id: string }>(
    `select n.id, similarity(n.content, $2) as r
     from notes n
     where n.user_id = $1 and n.content % $2
     order by r desc, n.id desc
     limit $3`,
    [userId, query, limit],
  );

  const seen = new Set(tsIds);
  const merged = [...tsIds];
  let added = 0;
  for (const row of fallback.rows) {
    const id = Number(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
    added += 1;
    if (merged.length >= limit) break;
  }

  const via = tsIds.length > 0 ? 'tsquery' : added > 0 ? 'trigram' : 'none';
  return { ids: merged, via };
}

export interface HybridSearchDebug {
  hits: SearchHit[];
  keywordPath: 'tsquery' | 'trigram' | 'none';
  tokens: number;
  vectorCandidates: number;
  keywordCandidates: number;
  /** 两路原始候选 id，评测/排障用（≤ candidateLimit 条） */
  vectorIds: number[];
  keywordIds: number[];
}

/** 带调试信息的版本：评测/排障用，能看到关键词路到底走没走 */
export async function hybridSearchDebug(
  pool: AppPool,
  opts: HybridSearchOptions,
): Promise<HybridSearchDebug> {
  const { userId, query, queryVec, topK = 12, candidateLimit = 40, efSearch = 40 } = opts;
  const client = await pool.connect();

  let vecIds: number[] = [];
  let kw: { ids: number[]; via: 'tsquery' | 'trigram' | 'none' } = { ids: [], via: 'none' };

  try {
    await client.query('BEGIN');
    // hnsw.ef_search 只能在事务内 SET LOCAL
    await client.query(`SET LOCAL hnsw.ef_search = ${Math.max(1, Math.floor(efSearch))}`);
    if (queryVec) {
      vecIds = await vectorCandidates(client, userId, queryVec, candidateLimit);
    }
    kw = await keywordCandidates(client, userId, query, candidateLimit);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const fused = fuseRrf(vecIds, kw.ids).slice(0, topK);
  if (fused.length === 0) {
    return {
      hits: [],
      keywordPath: kw.via,
      tokens: tokenize(query).length,
      vectorCandidates: 0,
      keywordCandidates: 0,
      vectorIds: [],
      keywordIds: [],
    };
  }

  const detail = await pool.query<{ id: string; title: string; content: string }>(
    `select id, title, content from notes where user_id = $1 and id = any($2::bigint[])`,
    [userId, fused.map((f) => f.id)],
  );
  const byId = new Map(detail.rows.map((r) => [Number(r.id), r]));

  const hits: SearchHit[] = [];
  for (const f of fused) {
    const row = byId.get(f.id);
    if (!row) continue;
    hits.push({
      id: f.id,
      title: row.title,
      content: row.content,
      score: Number(f.score.toFixed(6)),
      source: toSource(f),
    });
  }

  return {
    hits,
    keywordPath: kw.via,
    tokens: tokenize(query).length,
    vectorCandidates: vecIds.length,
    keywordCandidates: kw.ids.length,
    vectorIds: vecIds,
    keywordIds: kw.ids,
  };
}

export async function hybridSearch(pool: AppPool, opts: HybridSearchOptions): Promise<SearchHit[]> {
  return (await hybridSearchDebug(pool, opts)).hits;
}

/** 纯向量检索：评测基线用，与 hybridSearch 共用同一套取数逻辑 */
export async function vectorOnlySearch(
  pool: AppPool,
  userId: number,
  queryVec: number[],
  topK: number,
): Promise<number[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL hnsw.ef_search = 40');
    const ids = await vectorCandidates(client, userId, queryVec, topK);
    await client.query('COMMIT');
    return ids;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export type { Pool as PgPool };
