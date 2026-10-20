import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config.js';

/**
 * ComfyUI 永远是可选项。任何异常一律返回 null，绝不重试、绝不影响文本链路。
 * 默认无鉴权，只能跑在内网/本机，禁止暴露公网。
 */

interface ComfyPromptResponse {
  prompt_id?: string;
  error?: unknown;
}

interface ComfyHistory {
  [promptId: string]: {
    status?: { completed?: boolean; status_str?: string };
    outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }>;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function submitWorkflow(prompt: string, base: string): Promise<string> {
  // 这里放一个最小的占位工作流；实际使用时把节点换成你自己的 JSON
  const workflow = {
    prompt: {
      '6': {
        class_type: 'CLIPTextEncode',
        inputs: { text: prompt, clip: ['4', 0] },
      },
    },
    client_id: randomUUID(),
  };

  const res = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflow),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json()) as ComfyPromptResponse;
  if (!json.prompt_id) throw new Error('ComfyUI 未返回 prompt_id');
  return json.prompt_id;
}

async function waitForImage(promptId: string, base: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/history/${promptId}`, { signal: AbortSignal.timeout(5000) });
    const json = (await res.json()) as ComfyHistory;
    const entry = json[promptId];
    if (entry?.status?.status_str === 'error') throw new Error('execution_error');
    const images = Object.values(entry?.outputs ?? {}).flatMap((o) => o.images ?? []);
    if (images.length > 0) return images[0]!;
    await sleep(1000);
  }
  throw new Error('ComfyUI timeout');
}

async function fetchAndStore(
  image: { filename: string; subfolder: string; type: string },
  base: string,
): Promise<string> {
  const url = new URL(`${base}/view`);
  url.searchParams.set('filename', image.filename);
  url.searchParams.set('subfolder', image.subfolder);
  url.searchParams.set('type', image.type);

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`下载图片失败 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const dir = path.resolve(env.STORAGE_DIR, 'images');
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.png`;
  await writeFile(path.join(dir, filename), buf);
  return `/static/images/${filename}`;
}

/**
 * 返回可访问的 URL，失败返回 null。
 * 调用时机：文本 done 之后再异步触发，不要让 SSE 连接挂着等图。
 */
export async function tryGenerateImage(
  prompt: string,
  deps: { log: FastifyBaseLogger },
): Promise<string | null> {
  if (!env.COMFYUI_ENABLED) return null;
  const base = env.COMFYUI_URL.replace(/\/$/, '');
  try {
    const promptId = await submitWorkflow(prompt, base);
    const image = await waitForImage(promptId, base, env.COMFYUI_TIMEOUT_MS);
    return await fetchAndStore(image, base);
  } catch (err) {
    deps.log.warn({ err }, '[comfyui] 生成失败，降级为纯文本');
    return null;
  }
}

/** 健康探测：只用于 /healthz 的附加信息，不阻塞 */
export async function comfyuiHealthy(): Promise<boolean> {
  if (!env.COMFYUI_ENABLED) return false;
  try {
    const res = await fetch(`${env.COMFYUI_URL.replace(/\/$/, '')}/system_stats`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
