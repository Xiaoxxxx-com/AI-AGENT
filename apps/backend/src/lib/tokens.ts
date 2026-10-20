/**
 * Token 估算：不要用 tiktoken 硬套，DeepSeek 分词器不同。
 * 中文按 1 token/字，其余按 1 token/3.5 字符，误差应在 10% 以内；
 * 上线前用一次真实请求的 usage.prompt_tokens 校准 COEF_NON_CJK。
 */
const COEF_NON_CJK = 3.5;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  const rest = Math.max(0, text.length - cjk);
  return Math.ceil(cjk * 1.0 + rest / COEF_NON_CJK);
}

export function truncateToTokens(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (estimateTokens(text) <= budget) return text;
  // 粗粒度二分，够用且不引入依赖
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}
