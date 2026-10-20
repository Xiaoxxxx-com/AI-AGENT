/**
 * LLM 层契约自检（不需要数据库）。
 *
 * 验证项目里的封装在真实 HTTP 语义下行为正确：
 *   createEmbedder / chatText / chatJson / chatStream / shouldReachOut
 *
 *   pnpm smoke:llm            # 打本地 mock（需先 pnpm mock:llm）
 *   pnpm smoke:llm --real     # 用 .env 里的真实配置，跳过 embedding 检查
 *
 * --real 只测对话链路：embedding 通常是另一个服务（Ollama / 云厂商），
 * 没配好时不该让「对话能不能用」这件事判失败。
 */
const REAL = process.argv.includes('--real');

if (!REAL) {
  process.env.DEEPSEEK_BASE_URL ??= 'http://127.0.0.1:4010/v1';
  process.env.EMBEDDING_BASE_URL ??= 'http://127.0.0.1:4010/v1';
  process.env.DEEPSEEK_API_KEY ??= 'mock-key';
  process.env.EMBEDDING_API_KEY ??= 'mock-key';
}
process.env.JWT_SECRET ??= 'x'.repeat(48);
process.env.DATABASE_URL ??= 'postgres://companion:companion_dev@127.0.0.1:5432/companion';

let pass = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
};

const { createEmbedderFromEnv, cosineSimilarity } = await import(
  '../apps/backend/src/memory/embed.js'
);
const { chatText, chatJson, chatStream, shouldReachOut } = await import(
  '../apps/backend/src/chat/deepseek.js'
);
const { env } = await import('../apps/backend/src/config.js');
// 从 apps/backend 的依赖上下文解析 zod，避免在根目录重复装一份
const { createRequire } = await import('node:module');
const backendRequire = createRequire(new URL('../apps/backend/package.json', import.meta.url));
const { z } = backendRequire('zod') as typeof import('zod');

const embedder = REAL ? null : createEmbedderFromEnv(env);
console.log(
  `对话 ${env.DEEPSEEK_BASE_URL} · 模型 ${env.DEEPSEEK_MODEL}` +
    (REAL ? '（--real，跳过 embedding）' : ` · embedding ${env.EMBEDDING_BASE_URL}`),
);

let vecA: number[] = [];
let vecB: number[] = [];

if (!REAL && embedder) {
  await check('embedding 维度与配置一致', async () => {
    const [a, b] = await embedder.embed(['最近工作压力大，天天加班', '周末在家躺了两天']);
    if (!a || !b) throw new Error('返回为空');
    if (a.length !== env.EMBEDDING_DIM) throw new Error(`维度 ${a.length} != ${env.EMBEDDING_DIM}`);
    vecA = a;
    vecB = b;
  });

  await check('相关文本相似度高于无关文本', async () => {
    const [q] = await embedder.embed(['加班到十点很累']);
    if (!q) throw new Error('查询向量为空');
    const related = cosineSimilarity(q, vecA);
    const unrelated = cosineSimilarity(q, vecB);
    if (!(related > unrelated)) throw new Error(`相关 ${related.toFixed(3)} 未高于无关 ${unrelated.toFixed(3)}`);
  });
}

await check('chatText 返回非空文本', async () => {
  // 思考模型的推理也吃 token，这里给足预算，避免测出"空回复"这种假故障
  const text = await chatText([{ role: 'user', content: '今天有点累' }], { maxTokens: 600 });
  if (!text) throw new Error('空回复');
});

await check('chatStream 逐块吐出 token', async () => {
  const stream = await chatStream([{ role: 'user', content: '随便说一句' }], { maxTokens: 600 });
  let chunks = 0;
  let text = '';
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      chunks += 1;
      text += delta;
    }
  }
  if (chunks < 2) throw new Error(`只收到 ${chunks} 个块，流式可能退化成一次性返回`);
  if (!text) throw new Error('拼接结果为空');
});

await check('chatJson 返回可被 zod 解析的 JSON', async () => {
  const schema = z.object({ insights: z.array(z.unknown()) });
  // 提示词要写清目标结构：真实模型不会对"整理一下"这种含糊指令返回固定字段
  const result = await chatJson(
    [
      {
        role: 'user',
        content:
          '把下面两条记录归纳成 {"insights": [...]} 这个 JSON，insights 是字符串数组："\n' +
          '1) 这周连续加班到十点 2) 周末想补觉但更累',
      },
    ],
    schema,
    { maxTokens: 600 },
  );
  if (!Array.isArray(result.insights)) throw new Error('缺少 insights 数组');
});

await check('shouldReachOut 解析出结构化决策', async () => {
  const decision = await shouldReachOut([{ role: 'user', content: '候选由头：24 小时内有新笔记' }]);
  if (typeof decision.decision !== 'boolean') throw new Error('decision 不是布尔');
  if (!['low', 'medium', 'high'].includes(decision.urgency)) throw new Error('urgency 非法');
});

console.log(`\n${pass} 项通过${process.exitCode ? '，存在失败' : ''}`);
