import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from '../db/client.js';
import { env } from '../config.js';
import { sendSubscribeMessage } from '../auth/wechat.js';
import { formatCst } from '../lib/time.js';

/**
 * 投递：订阅消息（拉人回来）+ 站内 pending（正文）。
 * 全文永远只存在 proactive_log.message，模板里只放"她给你留了一句话"。
 * 发送失败不重试、不轰炸，直接降级成站内。
 */

export interface DeliveryDeps {
  pool: Pool;
  log: FastifyBaseLogger;
}

interface LogRow {
  id: string;
  user_id: string;
  message: string;
  created_at: Date;
  status: string;
  openid: string | null;
  subscription_quota: number;
}

export async function deliverProactive(deps: DeliveryDeps, proactiveId: number): Promise<void> {
  const { pool, log } = deps;

  const { rows } = await pool.query<LogRow>(
    `select p.id, p.user_id, p.message, p.created_at, p.status,
            u.wechat_openid as openid, u.subscription_quota
     from proactive_log p
     join users u on u.id = p.user_id
     where p.id = $1`,
    [proactiveId],
  );
  const row = rows[0];
  if (!row) {
    log.warn({ proactiveId }, '[deliver] 记录不存在');
    return;
  }
  if (row.status !== 'queued') {
    // 幂等：重复投递直接跳过，避免心跳重试重复发送
    log.debug({ proactiveId, status: row.status }, '[deliver] 已处理，跳过');
    return;
  }

  const canSubscribe =
    env.isProd || env.wechatEnabled
      ? Boolean(row.openid && row.subscription_quota > 0 && env.WECHAT_TEMPLATE_PROACTIVE && env.wechatEnabled)
      : false;

  if (canSubscribe && row.openid) {
    const result = await sendSubscribeMessage({
      openid: row.openid,
      templateId: env.WECHAT_TEMPLATE_PROACTIVE,
      page: `pages/chat/index?proactiveId=${proactiveId}`,
      data: {
        // 字段名必须与申请的模板一致，这里只是占位
        thing1: { value: '她给你留了一句话' },
        time2: { value: formatCst(row.created_at) },
      },
    });

    if (result.ok) {
      await pool.query(
        `update proactive_log
         set status = 'sent', channel = 'subscribe_msg', delivered_at = now()
         where id = $1 and status = 'queued'`,
        [proactiveId],
      );
      // 一次授权通常只能发一条，必须记账
      await pool.query(
        `update users set subscription_quota = greatest(subscription_quota - 1, 0), updated_at = now()
         where id = $1`,
        [Number(row.user_id)],
      );
      log.info({ proactiveId }, '[deliver] 订阅消息已发送');
      return;
    }

    log.warn({ proactiveId, errcode: result.errcode, errmsg: result.errmsg }, '[deliver] 订阅消息失败，降级站内');
  }

  await pool.query(
    `update proactive_log
     set status = 'sent', channel = 'in_app', delivered_at = now()
     where id = $1 and status = 'queued'`,
    [proactiveId],
  );
  log.info({ proactiveId }, '[deliver] 已写入站内待读');
}

/** 小程序进入时拉取未读全文，并标记 read */
export async function takePendingProactive(pool: Pool, userId: number, limit = 5) {
  const { rows } = await pool.query<{
    id: string;
    message: string;
    trigger_type: string;
    urgency: string;
    created_at: Date;
  }>(
    `select id, message, trigger_type, urgency, created_at
     from proactive_log
     where user_id = $1 and status = 'sent' and read_at is null
     order by created_at desc
     limit $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    message: r.message,
    triggerType: r.trigger_type,
    urgency: r.urgency,
    createdAt: r.created_at,
  }));
}

export async function markProactiveRead(pool: Pool, userId: number, id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update proactive_log set status = 'read', read_at = now()
     where id = $1 and user_id = $2 and read_at is null`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}
