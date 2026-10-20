import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { QUEUE } from '../queue.js';
import { segmentNote } from '../memory/segment.js';

const noteInput = z.object({
  title: z.string().max(200).default(''),
  content: z.string().min(1).max(20_000),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().positive().optional(),
});

export async function registerNoteRoutes(app: FastifyInstance): Promise<void> {
  /** 新建笔记：同步分词（关键词路立刻可用）+ 异步 embedding（进队列） */
  app.post('/notes', { preHandler: app.authenticate }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    const parsed = noteInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'bad-request',
        message: parsed.error.issues[0]?.message ?? '参数错误',
      });
    }
    const { title, content, tags } = parsed.data;

    const note = await app.pool.connect();
    let noteId = 0;
    try {
      await note.query('BEGIN');
      const { rows } = await note.query<{ id: string }>(
        `insert into notes (user_id, title, content, content_tokens)
         values ($1, $2, $3, $4)
         returning id`,
        [userId, title, content, segmentNote(title, content)],
      );
      noteId = Number(rows[0]?.id ?? 0);

      for (const name of tags ?? []) {
        const tag = await note.query<{ id: string }>(
          `insert into tags (user_id, name) values ($1, $2)
           on conflict (user_id, name) do update set name = excluded.name
           returning id`,
          [userId, name.trim()],
        );
        const tagId = Number(tag.rows[0]?.id ?? 0);
        if (tagId) {
          await note.query(
            `insert into note_tags (note_id, tag_id) values ($1, $2) on conflict do nothing`,
            [noteId, tagId],
          );
        }
      }
      await note.query('COMMIT');
    } catch (err) {
      await note.query('ROLLBACK').catch(() => undefined);
      req.log.error({ err, userId }, '[notes] 写入失败');
      return reply.code(500).send({ error: 'db-error' });
    } finally {
      note.release();
    }

    await app.boss.send(QUEUE.noteIndex, { noteId, userId }, { singletonKey: `note:${noteId}` });
    return reply.code(201).send({ id: noteId });
  });

  app.get('/notes', { preHandler: app.authenticate }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    const parsed = listQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });

    const { limit, cursor } = parsed.data;
    interface NoteRow {
      id: string;
      title: string;
      content: string;
      created_at: Date;
      has_embedding: boolean;
    }
    const { rows } = await app.pool.query<NoteRow>(
      `select id, title, content, created_at, (embedding is not null) as has_embedding
       from notes
       where user_id = $1 and ($2::bigint is null or id < $2::bigint)
       order by id desc
       limit $3`,
      [userId, cursor ?? null, limit],
    );

    return {
      items: rows.map((r: NoteRow) => ({
        id: Number(r.id),
        title: r.title,
        content: r.content,
        createdAt: r.created_at,
        hasEmbedding: r.has_embedding,
      })),
      nextCursor: rows.length === limit ? Number(rows[rows.length - 1]?.id) : null,
    };
  });

  app.delete('/notes/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad-request' });

    const { rowCount } = await app.pool.query(`delete from notes where id = $1 and user_id = $2`, [
      id,
      userId,
    ]);
    if (!rowCount) return reply.code(404).send({ error: 'not-found' });
    return { ok: true };
  });
}
