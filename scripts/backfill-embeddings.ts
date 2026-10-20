/**
 * 批量回填 embedding（换模型之后必须重跑）。
 * 用法：pnpm backfill:embeddings [--force] [--limit=200]
 *   --force  连同已有向量的笔记一起重算
 */
import 'dotenv/config';
import { createPool } from '../apps/backend/src/db/client.js';
import { createEmbedderFromEnv } from '../apps/backend/src/memory/embed.js';
import { embedNote, updateNoteTokens } from '../apps/backend/src/memory/index-note.js';
import { env } from '../apps/backend/src/config.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 500;

async function main(): Promise<void> {
  const pool = createPool(env.DATABASE_URL, 4, 'backfill');
  const embedder = createEmbedderFromEnv(env);

  let done = 0;
  let failed = 0;

  try {
    const { rows } = await pool.query<{ id: string; user_id: string; title: string; content: string }>(
      `select id, user_id, title, content from notes
       where ($1::boolean or embedding is null)
       order by id
       limit $2`,
      [force, limit],
    );
    console.log(`待处理 ${rows.length} 条（dim=${embedder.dim} model=${embedder.model}）`);

    for (const row of rows) {
      const noteId = Number(row.id);
      const userId = Number(row.user_id);
      try {
        await updateNoteTokens(pool, noteId, userId, row.title, row.content);
        await embedNote(pool, embedder, noteId, userId);
        done += 1;
        if (done % 10 === 0) console.log(`  已处理 ${done}/${rows.length}`);
      } catch (err) {
        failed += 1;
        console.error(`  #${noteId} 失败：`, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    await pool.end();
  }

  console.log(`完成：成功 ${done}，失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
