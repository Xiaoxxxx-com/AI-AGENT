import type { Pool } from '../db/client.js';
import { toTsQuery } from './segment.js';
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
  /** 单路候选数，默认 40。两路各取 40 再融合，避免单路长尾 */
  candidateLimit?: number;
  efSearch?: number;
}

const RRF_K = 60;

/**
 * 混合检索：向量路 + 关键词路，用 RRF 融合。
 * RRF: score = Σ 1 / (k + rank)，k=60 是经验值，不需要按数据调。
 */
export async function hybridSearch(pool: Pool, opts: HybridSearchOptions): Promise<SearchHit[]> {
  const { userId, query, queryVec, topK = 12, candidateLimit = 40, efSearch = 40 } = opts;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // hnsw.ef_search 只能在事务内 SET LOCAL
    await client.query(`SET LOCAL hnsw.ef_search = ${Math.max(1, Math.floor(efSearch))}`);

    const tsQuery = toTsQuery(query);
    const sql = queryVec
      ? `
        WITH q AS (
          SELECT $1::vector AS v, to_tsquery('simple', $2) AS ts
        ),
        vec AS (
          SELECT n.id, row_number() OVER (ORDER BY n.embedding <=> q.v) AS r
          FROM notes n, q
          WHERE n.user_id = $3 AND n.embedding IS NOT NULL
          ORDER BY n.embedding <=> q.v
          LIMIT $4
        ),
        kw AS (
          SELECT id, r FROM (
            SELECT n.id, row_number() OVER (
              ORDER BY ts_rank_cd(n.content_tsvector, q.ts) DESC, n.id DESC
            ) AS r
            FROM notes n, q
            WHERE n.user_id = $3 AND n.content_tsvector @@ q.ts
            LIMIT $4
          ) t
        ),
        fused AS (
          SELECT COALESCE(v.id, k.id) AS id,
                 COALESCE(1.0 / (${RRF_K} + v.r), 0) + COALESCE(1.0 / (${RRF_K} + k.r), 0) AS score,
                 (v.id IS NOT NULL) AS hit_vec,
                 (k.id IS NOT NULL) AS hit_kw
          FROM vec v
          FULL OUTER JOIN kw k ON v.id = k.id
        )
        SELECT f.id, n.title, n.content, f.score::float8 AS score, f.hit_vec, f.hit_kw
        FROM fused f
        JOIN notes n ON n.id = f.id
        ORDER BY score DESC, f.id DESC
        LIMIT $5
      `
      : `
        WITH q AS (
          SELECT to_tsquery('simple', $2) AS ts
        ),
        fused AS (
          SELECT n.id,
                 1.0 / (${RRF_K} + row_number() OVER (
                   ORDER BY ts_rank_cd(n.content_tsvector, q.ts) DESC, n.id DESC
                 )) AS score,
                 false AS hit_vec,
                 true AS hit_kw
          FROM notes n, q
          WHERE n.user_id = $3 AND n.content_tsvector @@ q.ts
          LIMIT $4
        )
        SELECT f.id, n.title, n.content, f.score::float8 AS score, f.hit_vec, f.hit_kw
        FROM fused f
        JOIN notes n ON n.id = f.id
        ORDER BY score DESC, f.id DESC
        LIMIT $5
      `;

    const params = queryVec
      ? [toSqlVector(queryVec), tsQuery, userId, candidateLimit, topK]
      : [null, tsQuery, userId, candidateLimit, topK];

    const { rows } = await client.query<{
      id: string;
      title: string;
      content: string;
      score: number;
      hit_vec: boolean;
      hit_kw: boolean;
    }>(sql, params);

    await client.query('COMMIT');

    return rows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      content: r.content,
      score: Number(r.score),
      source: r.hit_vec && r.hit_kw ? 'both' : r.hit_vec ? 'vector' : 'keyword',
    }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
