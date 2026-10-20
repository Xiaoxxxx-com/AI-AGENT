/**
 * 本地 mock 的 OpenAI 兼容服务（仅开发用，不要部署）。
 *
 * 用途：没有 DeepSeek API Key、也没有 Ollama 时，仍然能把整条链路跑通——
 *   · /v1/embeddings        → 确定性哈希向量（bag-of-tokens），能验证混合检索、HNSW 索引、去重
 *   · /v1/chat/completions  → 支持普通回复、JSON 模式（反思）、tool_calls（心跳）、stream（SSE 对话）
 *
 * 它**不是**语义模型：向量只反映词面重叠，别用它评估检索效果。
 * 启动：pnpm mock:llm          （默认 4010 端口）
 * 用法：DEEPSEEK_BASE_URL=http://127.0.0.1:4010/v1 EMBEDDING_BASE_URL=http://127.0.0.1:4010/v1 pnpm dev
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { tokenize } from '../apps/backend/src/memory/segment.js';

const PORT = Number(process.env.MOCK_PORT ?? 4010);
const DIM = Number(process.env.EMBEDDING_DIM ?? 1024);
const FORCE_REACH_OUT = process.env.MOCK_REACH_OUT === 'true';

function hashIndex(token: string, salt = 0): number {
  const digest = createHash('sha1').update(`${salt}:${token}`).digest();
  return digest.readUInt32BE(0) % DIM;
}

/**
 * 词面哈希向量：token 与相邻字符二元组各投两个桶，再 L2 归一化。
 * 同一个词在两条文本里会落到同一维，所以余弦相似度至少能反映“是否聊过同一个东西”。
 */
export function hashEmbedding(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  const tokens = tokenize(text);
  const chars = [...text].filter((c) => /[\u4e00-\u9fff\w]/.test(c));

  for (const token of tokens) {
    vec[hashIndex(token)]! += 2;
    vec[hashIndex(token, 7)]! += 1;
  }
  for (let i = 0; i < chars.length - 1; i += 1) {
    const bigram = `${chars[i]}${chars[i + 1]}`;
    vec[hashIndex(bigram)]! += 0.6;
    vec[hashIndex(bigram, 13)]! += 0.3;
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const BASE_CHUNK = {
  id: 'chatcmpl-mock',
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: 'mock-deepseek',
};

function sseWrite(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamCompletion(res: ServerResponse, reply: string): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  // 按字符切片，模拟真实首 token 延迟与逐字输出
  const pieces = [...reply];
  res.write(
    `data: ${JSON.stringify({ ...BASE_CHUNK, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
  );
  for (const piece of pieces) {
    await new Promise((r) => setTimeout(r, 25));
    sseWrite(res, { ...BASE_CHUNK, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
  }
  sseWrite(res, { ...BASE_CHUNK, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'GET' && (url === '/healthz' || url === '/')) {
    return json(res, 200, { ok: true, dim: DIM, service: 'mock-openai' });
  }

  // 推送通道的本地回声端点：验证 push.ts 的请求体是否合规（kind=generic 时用）
  if (req.method === 'POST' && url === '/push') {
    const raw = await readBody(req);
    let body: unknown = null;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { ok: false, error: 'bad-json' });
    }
    console.log('[mock-push]', JSON.stringify(body));
    return json(res, 200, { ok: true, received: body });
  }

  if (req.method !== 'POST') return json(res, 404, { error: 'not-found' });
  const raw = await readBody(req);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return json(res, 400, { error: 'bad-json' });
  }

  if (url.endsWith('/embeddings')) {
    const input = body.input;
    const inputs = Array.isArray(input) ? (input as string[]) : [String(input ?? '')];
    // OpenAI SDK 默认带 encoding_format=base64，必须遵守协议：
    // 否则客户端会把这串 float 当字节数组重解释，1024 维会变成 256 维
    const wantsBase64 = body.encoding_format === 'base64';
    return json(res, 200, {
      object: 'list',
      model: String(body.model ?? 'mock-embedding'),
      data: inputs.map((text, index) => {
        const vec = hashEmbedding(text);
        return {
          object: 'embedding',
          index,
          embedding: wantsBase64
            ? Buffer.from(new Float32Array(vec).buffer).toString('base64')
            : vec,
        };
      }),
      usage: { prompt_tokens: inputs.join('').length, total_tokens: inputs.join('').length },
    });
  }

  if (url.endsWith('/chat/completions')) {
    const messages = (body.messages ?? []) as { role: string; content: string }[];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const hasTools = Array.isArray(body.tools) && (body.tools as unknown[]).length > 0;
    const wantsJson = (body.response_format as { type?: string } | undefined)?.type === 'json_object';

    // 心跳的决策工具：默认克制，MOCK_REACH_OUT=true 时才同意发消息
    if (hasTools && !body.stream) {
      const args = {
        decision: FORCE_REACH_OUT,
        reason: FORCE_REACH_OUT ? 'mock：强制触发一次主动消息' : 'mock：对方没有明显由头，保持沉默',
        suggested_angle: '顺着他刚写的那件事轻轻问一句',
        urgency: 'low',
      };
      return json(res, 200, {
        id: 'chatcmpl-mock-tool',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-deepseek',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_mock_1',
                  type: 'function',
                  function: { name: 'should_reach_out', arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    }

    // 反思走 JSON 模式：返回空洞察，避免污染测试数据（要造数据就手动往库里插）
    if (wantsJson) {
      return json(res, 200, {
        id: 'chatcmpl-mock-json',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-deepseek',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify({ insights: [] }) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }

    const reply =
      lastUser.includes('摘要') || lastUser.includes('摘要正文')
        ? '对方最近在准备转岗面试，改了三版简历仍嫌项目单薄；常加班到十点，睡眠被推到两点。楼下橘猫让他想养猫，但房东不允许。和妈妈通电话时说忙，其实想回家吃红烧排骨。'
        : `（mock 回复）我听到了：${lastUser.slice(0, 40)}。这句话是本地 mock 服务生成的，用来验证流式链路是否通畅。`;

    if (body.stream) {
      await streamCompletion(res, reply);
      return undefined;
    }

    return json(res, 200, {
      id: 'chatcmpl-mock-text',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-deepseek',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
    });
  }

  return json(res, 404, { error: 'not-found', path: url });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-openai] listening on http://127.0.0.1:${PORT}/v1  dim=${DIM} forceReachOut=${FORCE_REACH_OUT}`);
});
