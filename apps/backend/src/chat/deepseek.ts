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

/**
 * deepseek-flash 是思考模型：先写 reasoning_content，再写正文，
 * 两者都计入 completion_tokens。预算给太少时正文会是空字符串、
 * finish_reason=length —— 看起来像"模型没返回"，其实是预算被推理吃光了。
 * 所以结构化调用至少要留 800 的余量。
 */
const MIN_STRUCTURED_BUDGET = 800;

function budget(requested: number | undefined, fallback: number): number {
  return Math.max(MIN_STRUCTURED_BUDGET, requested ?? fallback);
}

/** 从可能带 markdown 代码块的文本里抠出 JSON */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const braced = trimmed.match(/\{[\s\S]*\}/);
  if (braced?.[0]) candidates.push(braced[0]);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

export async function chatJson<S extends z.ZodTypeAny>(
  messages: ChatMessage[],
  schema: S,
  opts: ChatOptions = {},
): Promise<z.infer<S>> {
  // DeepSeek 的 json_object 模式要求提示词里出现 "json"，否则直接 400。
  // 调用方的 prompt 不一定提这个词，这里补一句，避免整个反思任务挂掉。
  const mentionsJson = messages.some(
    (m) => typeof m.content === 'string' && /json/i.test(m.content),
  );
  const safeMessages: ChatMessage[] = mentionsJson
    ? messages
    : [
        { role: 'system', content: '只输出一个 JSON 对象（json object），不要解释，不要 markdown 代码块。' },
        ...messages,
      ];

  const res = await deepseek.chat.completions.create(
    {
      model: env.DEEPSEEK_MODEL,
      messages: safeMessages,
      max_tokens: budget(opts.maxTokens, 1200),
      temperature: opts.temperature ?? 0.2,
      stream: false,
      response_format: { type: 'json_object' },
    },
    { signal: opts.signal },
  );
  const choice = res.choices[0];
  const raw = choice?.message?.content ?? '';
  const parsed = extractJson(raw);
  if (parsed === null) {
    if (choice?.finish_reason === 'length') {
      throw new Error(
        `token 预算被推理耗尽（finish_reason=length）：max_tokens=${budget(opts.maxTokens, 1200)}。` +
          '思考模型的 reasoning 也计入 completion_tokens，请调大预算。',
      );
    }
    throw new Error(`LLM 返回的不是合法 JSON：${raw.slice(0, 200) || '(空内容)'}`);
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
  const base = {
    model: env.DEEPSEEK_MODEL,
    messages,
    tools: [SHOULD_REACH_OUT_TOOL],
    temperature: 0.2,
    max_tokens: budget(opts.maxTokens, 1200),
    stream: false as const,
  };

  let res;
  try {
    res = await deepseek.chat.completions.create(
      { ...base, tool_choice: { type: 'function', function: { name: 'should_reach_out' } } },
      { signal: opts.signal },
    );
  } catch (err) {
    // 思考模式（deepseek-flash/reasoner）不支持强制 tool_choice：400 后降级重试一次
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status;
    if (status === 400 && /tool_choice/i.test(message)) {
      res = await deepseek.chat.completions.create(
        { ...base, tool_choice: 'auto' },
        { signal: opts.signal },
      );
    } else {
      throw err;
    }
  }

  const msg = res.choices[0]?.message;
  const call = msg?.tool_calls?.[0];
  if (call && call.type === 'function') {
    const rawArgs = call.function.arguments || '';
    const args = extractJson(rawArgs);
    if (args !== null) return ReachOutDecision.parse(args);
    throw new Error(
      rawArgs
        ? `tool_calls.arguments 不是合法 JSON：${rawArgs.slice(0, 120)}`
        : 'tool_calls.arguments 为空（多半是 token 预算被推理耗尽）',
    );
  }

  // 没走工具调用时，有的模型会直接把 JSON 写进 content
  const fallback = extractJson(msg?.content ?? '');
  if (fallback !== null) return ReachOutDecision.parse(fallback);

  throw new Error('模型既没有返回 tool_calls，也没有返回可解析的 JSON');
}
