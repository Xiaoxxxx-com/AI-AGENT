import { env } from '../config.js';

/**
 * 微信小程序登录与订阅消息。
 * 铁律：session_key 不落库、不返回、不进日志。
 */

export interface JsCodeSession {
  openid: string;
  unionid?: string;
  sessionKey: string;
}

interface JsCodeResponse {
  openid?: string;
  unionid?: string;
  session_key?: string;
  errcode?: number;
  errmsg?: string;
}

export async function jscode2session(code: string): Promise<JsCodeSession> {
  if (!env.wechatEnabled) {
    throw new Error('WECHAT_APPID / WECHAT_SECRET 未配置，无法登录');
  }
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', env.WECHAT_APPID);
  url.searchParams.set('secret', env.WECHAT_SECRET);
  url.searchParams.set('js_code', code);
  url.searchParams.set('grant_type', 'authorization_code');

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const json = (await res.json()) as JsCodeResponse;

  if (!json.openid || json.errcode) {
    throw new Error(`jscode2session 失败：${json.errcode ?? 'unknown'} ${json.errmsg ?? ''}`.trim());
  }
  return { openid: json.openid, unionid: json.unionid, sessionKey: json.session_key ?? '' };
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

/** access_token 有效期 2 小时，必须缓存，每次刷新会被微信限流 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token;

  const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
  url.searchParams.set('grant_type', 'client_credential');
  url.searchParams.set('appid', env.WECHAT_APPID);
  url.searchParams.set('secret', env.WECHAT_SECRET);

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
  if (!json.access_token) {
    throw new Error(`获取 access_token 失败：${json.errcode ?? 'unknown'} ${json.errmsg ?? ''}`.trim());
  }
  tokenCache = {
    token: json.access_token,
    expiresAt: now + (json.expires_in ?? 7200) * 1000,
  };
  return tokenCache.token;
}

export interface SubscribeMessageResult {
  ok: boolean;
  errcode?: number;
  errmsg?: string;
}

/**
 * 订阅消息只能发模板，不能发自由文本；模板字段名以你申请的模板为准。
 * 常见失败：43101 用户拒绝/配额用尽，40003 openid 非法 —— 一律不重试轰炸。
 */
export async function sendSubscribeMessage(params: {
  openid: string;
  templateId: string;
  page: string;
  data: Record<string, { value: string }>;
}): Promise<SubscribeMessageResult> {
  try {
    const token = await getAccessToken();
    const res = await fetch(
      `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          touser: params.openid,
          template_id: params.templateId,
          page: params.page,
          data: params.data,
          miniprogram_state: env.isProd ? 'formal' : 'developer',
          lang: 'zh_CN',
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const json = (await res.json()) as { errcode?: number; errmsg?: string };
    if (json.errcode === 0) return { ok: true };
    return { ok: false, errcode: json.errcode, errmsg: json.errmsg };
  } catch (err) {
    return { ok: false, errmsg: err instanceof Error ? err.message : 'network error' };
  }
}
