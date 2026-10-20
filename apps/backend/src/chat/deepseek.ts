import OpenAI from 'openai';
import { z } from 'zod';
import { env } from '../config.js';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * DeepSeek 走 OpenAI 兼容协议。模型名走环境变量：deepseek-chat 是旧名，正在退役。
 */
export const deepseek = new OpenAI({
  baseURL: env.DEEPSEEK_BASE_URL,
  apiKey: env.DEEPSEEK_API_KEY,
  timeout: env.DEEPSEEK_TIMEOUT_MS,
  maxRetries: 1,
});

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export async function chatText(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const res = await deepseek.chat.completions.create(
    {
      model: env.DEEPSEEK_MODEL,
      messages,
      max_tokens: opts.maxTokens ?? 800,
      temperature: opts.temperature ?? 0.6,
      stream: false,
    },
    { signal: opts.signal },
  );
  return res.choices[0]?.message?.content?.trim() ?? '';
}

export async function chatJson<S extends z.ZodTypeAny>(
  messages: ChatMessage[],
  schema: S,
  opts: ChatOptions = {},
): Promise<z.infer<S>> {
  const res = await deepseek.chat.completions.create(
    {
      model: env.DEEPSEEK_MODEL,
      messages,
      max_tokens: opts.maxTokens ?? 1200,
      temperature: opts.temperature ?? 0.2,
      stream: false,
      response_format: { type: 'json_object' },
    },
    { signal: opts.signal },
  );
  const raw = res.choices[0]?.message?.content ?? '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`LLM 返回的不是合法 JSON：${raw.slice(0, 200)}`);
  }
  return schema.parse(parsed);
}

/** 流式对话：调用方负责组装 SSE 事件 */
export function chatStream(messages: ChatMessage[], opts: ChatOptions = {}) {
  return deepseek.chat.completions.create(
    {
      model: env.DEEPSEEK_MODEL,
      messages,
      max_tokens: opts.maxTokens ?? 2000,
      temperature: opts.temperature ?? 0.8,
      stream: true,
    },
    { signal: opts.signal },
  );
}

export const ReachOutDecision = z.object({
  decision: z.boolean(),
  reason: z.string(),
  suggested_angle: z.string(),
  urgency: z.enum(['low', 'medium', 'high']),
});

export type ReachOutDecision = z.infer<typeof ReachOutDecision>;

/**
 * 结构化工具调用。严格模式要求所有字段 required + additionalProperties:false，
 * 官方文档里 JSON Schema 严格模式需要 base URL 走 /beta；这里用非严格模式也能稳定拿到 JSON。
 */
const SHOULD_REACH_OUT_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'should_reach_out',
    description: '判断此刻是否适合主动联系用户。宁可少打扰，也不要为了调用而调用。',
    parameters: {
      type: 'object',
      properties: {
        decision: { type: 'boolean', description: 'true 表示现在适合发消息' },
        reason: { type: 'string', description: '一句话说明判断依据，会写进 proactive_log.reason' },
        suggested_angle: { type: 'string', description: '如果决定联系，最自然的切入点' },
        urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['decision', 'reason', 'suggested_angle', 'urgency'],
      additionalProperties: false,
    },
  },
};

export async function shouldReachOut(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ReachOutDecision> {
  const res = await deepseek.chat.completions.create(
    {
      model: env.DEEPSEEK_MODEL,
      messages,
      tools: [SHOULD_REACH_OUT_TOOL],
      tool_choice: { type: 'function', function: { name: 'should_reach_out' } },
      temperature: 0.2,
      max_tokens: 400,
      stream: false,
    },
    { signal: opts.signal },
  );

  const call = res.choices[0]?.message?.tool_calls?.[0];
  if (!call || call.type !== 'function') {
    throw new Error('模型没有返回 tool_calls');
  }
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    throw new Error('tool_calls.arguments 不是合法 JSON');
  }
  return ReachOutDecision.parse(args);
}
