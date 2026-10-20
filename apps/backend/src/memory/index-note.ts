import type { Pool } from '../db/client.js';
import type { Embedder } from './embed.js';
import { toSqlVector } from './embed.js';
import { segmentNote } from './segment.js';

/**
 * 笔记写入的两步：
 * 1. 同步分词（快，几十毫秒），保证关键词路立刻可用；
 * 2. 异步 embedding（慢，走队列），失败不影响笔记可用性。
 */
export async function updateNoteTokens(
  pool: Pool,
  noteId: number,
  userId: number,
  title: string,
  content: string,
): Promise<void> {
  await pool.query(
    `update notes set content_tokens = $3, updated_at = now()
     where id = $1 and user_id = $2`,
    [noteId, userId, segmentNote(title, content)],
  );
}

export async function embedNote(
  pool: Pool,
  embedder: Embedder,
  noteId: number,
  userId: number,
): Promise<boolean> {
  const { rows } = await pool.query<{ title: string; content: string }>(
    `select title, content from notes where id = $1 and user_id = $2`,
    [noteId, userId],
  );
  const note = rows[0];
  if (!note) return false;

  const text = `${note.title}\n${note.content}`.trim();
  if (!text) return false;

  const [vec] = await embedder.embed([text]);
  if (!vec) return false;

  await pool.query(
    `update notes
     set embedding = $1::vector, embedding_model = $2, embedding_updated_at = now()
     where id = $3 and user_id = $4`,
    [toSqlVector(vec), embedder.model, noteId, userId],
  );
  return true;
}
