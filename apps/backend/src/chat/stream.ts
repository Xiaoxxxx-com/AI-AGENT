import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config.js';
import { assembleContext } from '../memory/assemble.js';
import { chatStream } from './deepseek.js';
import { onUserMessage, saveMessage } from './messages.js';
import { CRISIS_DIRECTIVE, crisisLogFields, detectCrisis } from './safety.js';
import { QUEUE } from '../queue.js';

const chatInput = z.object({
  message: z.string().min(1).max(4000),
  sessionId: z.string().uuid().optional(),
});

/**
 * SSE 对话链路。几个必须守住的点：
 * - 用 sse:'only'，不要用 sse:true（dual 模式会被 Accept: *\\/ * 带到非流式分支）；
 * - 先组装上下文再落当前用户消息，避免当前消息在 recent 里出现两次；
 * - 客户端断开必须 abort 上游，否则用户退出后还在烧 token；
 * - 助手消息在 finally 落库，中断也保留半截。
 */
export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  /** 会话历史（进入页面时回填；分页按 id 倒序游标） */
  app.get('/chat/history', { preHandler: app.authenticate }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    const q = req.query as { sessionId?: string; limit?: string; before?: string };
    const limit = Math.min(100, Number(q.limit ?? 30) || 30);
    const before = q.before ? Number(q.before) : null;
    if (!q.sessionId) return { items: [] };

    interface HistoryRow {
      id: string;
      role: string;
      content: string;
      created_at: Date;
    }
    const { rows } = await app.pool.query<HistoryRow>(
      `select id, role, content, created_at from conversations
       where user_id = $1 and session_id = $2 and role in ('user','assistant')
         and ($3::bigint is null or id < $3::bigint)
       order by id desc
       limit $4`,
      [userId, q.sessionId, before, limit],
    );

    return {
      items: rows.reverse().map((r: HistoryRow) => ({
        id: Number(r.id),
        role: r.role,
        content: r.content,
        createdAt: r.created_at,
      })),
    };
  });

  app.post('/chat/stream', { sse: 'only', preHandler: app.authenticate }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    // 嵌套的 async generator 里 TS 会丢掉收窄结果，这里固化成 number
    const uid: number = userId;

    const parsed = chatInput.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad-request', message: parsed.error.issues[0]?.message ?? '参数错误' };
    }

    const { message } = parsed.data;
    const sessionId = parsed.data.sessionId ?? randomUUID();
    const traceId = randomUUID();

    const ctx = await assembleContext(app.pool, app.embedder, uid, message);

    // 危机内容不拦截对话，只把固定安全指令压到 system 最前面
    const verdict = detectCrisis(message);
    if (verdict.level === 'crisis') {
      const sys = ctx.messages[0];
      if (sys?.role === 'system') sys.content += CRISIS_DIRECTIVE;
      req.log.warn(
        { userId: uid, traceId, ...crisisLogFields(verdict) },
        '[chat] 命中危机关键词，已注入安全指令',
      );
    }

    const userMsgId = await saveMessage(app.pool, {
      userId: uid,
      role: 'user',
      content: message,
      sessionId,
      traceId,
    });
    await onUserMessage(app.pool, uid);

    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());

    let upstream: Awaited<ReturnType<typeof chatStream>>;
    try {
      upstream = await chatStream(ctx.messages, {
        maxTokens: 2000,
        signal: ac.signal,
      });
    } catch (err) {
      req.log.error({ err, userId }, '[chat] 上游调用失败');
      await reply.sse.send({
        event: 'error',
        data: { code: 'upstream_error', message: '模型服务暂时不可用' },
      });
      await reply.sse.send({ event: 'done', data: { ok: false } });
      return;
    }

    async function* events() {
      let full = '';
      const startedAt = Date.now();
      let firstTokenAt: number | null = null;

      try {
        yield {
          event: 'meta',
          data: {
            messageId: userMsgId,
            sessionId,
            traceId,
            context: ctx.meta,
            safety: verdict.level,
          },
        };

        for await (const chunk of upstream) {
          if (ac.signal.aborted) break;
          const delta = chunk.choices[0]?.delta?.content;
          if (!delta) continue;
          if (firstTokenAt === null) firstTokenAt = Date.now();
          full += delta;
          yield { event: 'token', data: { text: delta } };
        }

        req.log.info(
          {
            userId: uid,
            traceId,
            model: env.DEEPSEEK_MODEL,
            ttftMs: firstTokenAt ? firstTokenAt - startedAt : null,
            totalMs: Date.now() - startedAt,
            chars: full.length,
          },
          '[chat] stream finished',
        );

        yield { event: 'done', data: { ok: true, messageId: userMsgId } };
      } catch (err) {
        req.log.error({ err, userId: uid, traceId }, '[chat] 流中断');
        yield { event: 'error', data: { code: 'stream_error', message: '回答中断了' } };
        yield { event: 'done', data: { ok: false, messageId: userMsgId } };
      } finally {
        if (full) {
          await saveMessage(app.pool, {
            userId: uid,
            role: 'assistant',
            content: full,
            sessionId,
            model: env.DEEPSEEK_MODEL,
            traceId,
          }).catch((err: unknown) => req.log.error({ err }, '[chat] 助手消息落库失败'));
        }
        // 交给后台判断是否够格摘要（阈值判断在 worker 里）
        await app.boss
          .send(
            QUEUE.memorySummarize,
            { userId: uid, sessionId },
            { singletonKey: `sum:${uid}:${sessionId}` },
          )
          .catch((err: unknown) => req.log.warn({ err }, '[chat] 摘要任务入队失败'));
      }
    }

    await reply.sse.send(events());
  });
}
