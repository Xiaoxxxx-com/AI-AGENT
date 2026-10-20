/**
 * 主动触达的「直推通道」（自用场景）。
 *
 * 为什么需要它：小程序订阅消息一次授权只能发一条，长期订阅只对政务/医疗/交通/金融/教育等
 * 类目开放，AI 陪伴拿不到。要真正“她主动找到你”，最省的办法是服务端把消息推到手机通知栏，
 * 点开再进小程序读正文、回话。
 *
 * 支持五种目标，全部只需要一个 URL（和可选的 target），零资质零成本：
 *   bark        iOS，https://api.day.app/<你的key>
 *   serverchan  https://sctapi.ftqq.com/<SENDKEY>.send
 *   wecom       企业微信群机器人 webhook
 *   telegram    https://api.telegram.org/bot<token>/sendMessage（target 填 chat_id）
 *   generic     任意自建 webhook，POST {title, body, link}
 *
 * 约束：只推一次，不重试。失败由 delivery 降级到订阅消息 / 站内，绝不对用户狂轰。
 */
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config.js';

export type PushKind = 'off' | 'bark' | 'serverchan' | 'wecom' | 'telegram' | 'generic';

export interface PushPayload {
  title: string;
  body: string;
  link?: string;
}

export interface PushResult {
  ok: boolean;
  kind: PushKind;
  error?: string;
}

export function pushEnabled(): boolean {
  return env.PUSH_KIND !== 'off' && Boolean(env.PUSH_URL);
}

function timeout(ms = 8000): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; json: unknown; status: number }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeout(),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, json, status: res.status };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export async function pushMessage(
  payload: PushPayload,
  deps: { log?: FastifyBaseLogger } = {},
): Promise<PushResult> {
  const kind = env.PUSH_KIND;

  if (kind === 'off' || !env.PUSH_URL) {
    return { ok: false, kind, error: 'push-not-configured' };
  }

  try {
    switch (kind) {
      case 'bark': {
        // bark 的 url 里已含 key，直接 POST 即可；group 让通知归类到「陪伴」
        const { ok, json, status } = await postJson(env.PUSH_URL, {
          title: payload.title,
          body: payload.body,
          group: 'companion',
          ...(payload.link ? { url: payload.link } : {}),
        });
        const code = Number(asRecord(json).code ?? 0);
        if (ok && (code === 200 || code === 0)) return { ok: true, kind };
        return { ok: false, kind, error: `bark ${status}/${code || 'n/a'}` };
      }

      case 'serverchan': {
        const { ok, json, status } = await postJson(env.PUSH_URL, {
          title: payload.title,
          desp: payload.link ? `${payload.body}\n\n${payload.link}` : payload.body,
        });
        const rec = asRecord(json);
        if (ok && (Number(rec.code ?? -1) === 0 || rec.data !== undefined)) return { ok: true, kind };
        return { ok: false, kind, error: `serverchan ${status}` };
      }

      case 'wecom': {
        const content = [payload.title, payload.body, payload.link].filter(Boolean).join('\n');
        const { ok, json, status } = await postJson(env.PUSH_URL, {
          msgtype: 'text',
          text: { content },
        });
        const errcode = Number(asRecord(json).errcode ?? -1);
        if (ok && errcode === 0) return { ok: true, kind };
        return { ok: false, kind, error: `wecom ${status}/${errcode}` };
      }

      case 'telegram': {
        if (!env.PUSH_TARGET) return { ok: false, kind, error: 'telegram 需要 PUSH_TARGET(chat_id)' };
        const { ok, json, status } = await postJson(env.PUSH_URL, {
          chat_id: env.PUSH_TARGET,
          text: [payload.title, payload.body, payload.link].filter(Boolean).join('\n\n'),
          disable_web_page_preview: true,
        });
        const success = asRecord(json).ok === true;
        if (ok && success) return { ok: true, kind };
        return { ok: false, kind, error: `telegram ${status}` };
      }

      case 'generic':
      default: {
        const { ok, status } = await postJson(env.PUSH_URL, {
          title: payload.title,
          body: payload.body,
          link: payload.link ?? null,
        });
        if (ok) return { ok: true, kind: 'generic' };
        return { ok: false, kind: 'generic', error: `generic ${status}` };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log?.warn({ err, kind }, '[push] 推送失败');
    return { ok: false, kind, error: message };
  }
}
