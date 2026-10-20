import type { FastifyServerOptions } from 'fastify';
import { env } from '../config.js';

/**
 * pino 结构化日志：
 * - openid / 消息全文属于隐私，日志里只留长度和 hash（这里直接 censor）。
 * - 开发环境用 pino-pretty，生产输出纯 JSON 交给采集器。
 */
export function buildLoggerOptions(): FastifyServerOptions['logger'] {
  return {
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.openid',
        '*.wechat_openid',
        '*.session_key',
        '*.content',
        '*.message',
      ],
      censor: '[redacted]',
    },
    transport: env.isProd
      ? undefined
      : {
          target: 'pino-pretty',
          options: {
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
            singleLine: false,
          },
        },
  };
}
