/**
 * 检索评测（§8.3）。
 *
 * 用法：pnpm eval:retrieval [--topK=10] [--cases=ops/eval/retrieval-cases.json]
 * 依赖：DATABASE_URL + seed 数据 + embedding 服务。
 *
 * 输出：hybrid vs 纯向量的 Recall@10、MRR、关键词路独有命中占比。
 * 判定：hybrid Recall 低于纯向量 → 先查 content_tsvector 是否为空（中文分词没跑）。
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createPool } from '../apps/backend/src/db/client.js';
import { createEmbedderFromEnv } from '../apps/backend/src/memory/embed.js';
import { hybridSearchDebug, vectorOnlySearch } from '../apps/backend/src/memory/hybrid-search.js';
import { env } from '../apps/backend/src/config.js';

interface EvalCase {
  query: string;
  /** 相关笔记的标题（seed 数据里标题唯一，比硬编码 id 稳） */
  relevant: string[];
}

const args = process.argv.slice(2);
const topK = Number(args.find((a) => a.startsWith('--topK='))?.split('=')[1] ?? 10);
const casesPath = args.find((a) => a.startsWith('--cases='))?.split('=')[1] ?? 'ops/eval/retrieval-cases.json';

const THRESHOLD = { recall: 0.8, mrr: 0.65, keywordShare: 0.15 };

async function main(): Promise<void> {
  const raw = await readFile(casesPath, 'utf8');
  const cases = JSON.parse(raw) as EvalCase[];
  const embedder = createEmbedderFromEnv(env);
  const pool = createPool(env.DATABASE_URL, 4, 'eval');

  try {
    const userRes = await pool.query<{ id: string }>(
      `select id from users where wechat_openid = 'seed-openid-001'`,
    );
    const userId = Number(userRes.rows[0]?.id);
    if (!userId) throw new Error('找不到 seed 用户，请先 pnpm db:seed');

    const noteRes = await pool.query<{ id: string; title: string; has_tokens: boolean }>(
      `select id, title, (content_tsvector is not null) as has_tokens from notes where user_id = $1`,
      [userId],
    );
    const idByTitle = new Map(noteRes.rows.map((r) => [r.title, Number(r.id)]));
    const missingTokens = noteRes.rows.filter((r) => !r.has_tokens).length;

    console.log(`样例 ${cases.length} 条 · 语料 ${noteRes.rows.length} 条 · topK=${topK}`);
    console.log(`模型 ${embedder.model}@${embedder.dim}`);
    if (missingTokens > 0) console.log(`⚠️  有 ${missingTokens} 条笔记 content_tsvector 为空，关键词路会缺失`);

    let hybridRecall = 0;
    let vectorRecall = 0;
    let keywordRecall = 0;
    let hybridMrr = 0;
    let vectorMrr = 0;
    let keywordOnlyHits = 0;
    let totalHits = 0;
    let skipped = 0;
    const pathStats = { tsquery: 0, trigram: 0, none: 0 };

    console.log('\nquery'.padEnd(28), 'hybrid'.padEnd(24), 'vector-only', 'kw路径');
    for (const c of cases) {
      const relevantIds = c.relevant
        .map((t) => idByTitle.get(t))
        .filter((id): id is number => typeof id === 'number');
      if (relevantIds.length === 0) {
        console.log(`  skip（标题未命中语料）: ${c.query} → ${c.relevant.join(' / ')}`);
        skipped += 1;
        continue;
      }

      const [qvec] = await embedder.embed([c.query]);
      const debug = await hybridSearchDebug(pool, {
        userId,
        query: c.query,
        queryVec: qvec ?? null,
        topK,
      });
      const hybrid = debug.hits;
      const vec = await vectorOnlySearch(pool, userId, qvec ?? [], topK);
      pathStats[debug.keywordPath] += 1;

      const hIds = hybrid.map((h) => h.id);
      const hHit = relevantIds.filter((id) => hIds.includes(id));
      const vHit = relevantIds.filter((id) => vec.includes(id));
      const kHit = relevantIds.filter((id) => debug.keywordIds.includes(id));

      hybridRecall += hHit.length / relevantIds.length;
      vectorRecall += vHit.length / relevantIds.length;
      keywordRecall += kHit.length / relevantIds.length;

      const hRank = hIds.findIndex((id) => relevantIds.includes(id));
      const vRank = vec.findIndex((id) => relevantIds.includes(id));
      hybridMrr += hRank >= 0 ? 1 / (hRank + 1) : 0;
      vectorMrr += vRank >= 0 ? 1 / (vRank + 1) : 0;

      totalHits += hybrid.length;
      keywordOnlyHits += hybrid.filter((h) => h.source === 'keyword').length;

      const fmt = (hit: number, total: number, rank: number) =>
        `${hit}/${total}${rank >= 0 ? ` @${rank + 1}` : ''}`.padEnd(24);
      console.log(
        c.query.padEnd(28),
        fmt(hHit.length, relevantIds.length, hRank),
        fmt(vHit.length, relevantIds.length, vRank),
        debug.keywordPath,
      );
    }

    const n = cases.length - skipped;
    if (n === 0) throw new Error('没有可评测的样例');

    const metrics = {
      'Recall@10 (hybrid)': hybridRecall / n,
      'Recall@10 (vector-only)': vectorRecall / n,
      'Recall@10 (keyword-only)': keywordRecall / n,
      'MRR (hybrid)': hybridMrr / n,
      'MRR (vector-only)': vectorMrr / n,
      '关键词路独有命中占比': totalHits > 0 ? keywordOnlyHits / totalHits : 0,
    };

    console.log('\n指标');
    for (const [k, v] of Object.entries(metrics)) {
      const target =
        k.includes('hybrid') && k.includes('Recall')
          ? `目标 ≥ ${THRESHOLD.recall}`
          : k.includes('MRR (hybrid)')
            ? `目标 ≥ ${THRESHOLD.mrr}`
            : k.includes('关键词')
              ? `目标 ≥ ${THRESHOLD.keywordShare}`
              : '基线';
      const flag =
        (k.includes('hybrid') && k.includes('Recall') && v < THRESHOLD.recall) ||
        (k.includes('MRR (hybrid)') && v < THRESHOLD.mrr) ||
        (k.includes('关键词') && v < THRESHOLD.keywordShare)
          ? '  ← 未达标'
          : '';
      console.log(`  ${k.padEnd(26)} ${v.toFixed(3)}   ${target}${flag}`);
    }

    if (metrics['Recall@10 (hybrid)'] < metrics['Recall@10 (vector-only)']) {
      console.log(
        '\n⚠️  hybrid 不如纯向量：先查 notes.content_tsvector 是否为空（中文分词没写进 content_tokens）。',
      );
    }
    console.log(
      `\n关键词路取数方式：tsquery ${pathStats.tsquery} 次 / trigram 兜底 ${pathStats.trigram} 次 / 无命中 ${pathStats.none} 次`,
    );
    if (noteRes.rows.length <= 40) {
      console.log(
        `⚠️  语料只有 ${noteRes.rows.length} 条，小于 candidateLimit=40：两路候选会完全重合，` +
          `「关键词独有命中」必然接近 0。跑 pnpm corpus:distractors 扩充语料后再评。`,
      );
    }
    if (metrics['关键词路独有命中占比'] < THRESHOLD.keywordShare && noteRes.rows.length > 40) {
      console.log('\n⚠️  关键词路独有命中偏低：分词停用词表可能过激，或语料领域过于单一。');
    }
    console.log(
      '\n提示：「关键词路独有命中」与 embedder 强相关。用词面向量（本地 mock）时两路高度重合，该指标天然接近 0；' +
        '\n     换成语义模型（bge-m3 / bge-large-zh）后才有区分度。判断关键词路是否健康，看 Recall@10 (keyword-only)。',
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
