import { describe, expect, it } from 'vitest';
import { estimateTokens, truncateToTokens } from '../apps/backend/src/lib/tokens';

describe('token 估算', () => {
  it('中文按字计', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('英文按 3.5 字符一个 token', () => {
    expect(estimateTokens('hello world')).toBe(Math.ceil(11 / 3.5));
  });

  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('中英混排接近真实比例', () => {
    const text = '今天 review 了 PR，感觉还行';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(text.length);
  });
});

describe('truncateToTokens', () => {
  it('预算足够时原样返回', () => {
    expect(truncateToTokens('短句', 100)).toBe('短句');
  });

  it('超预算时截断到不超标', () => {
    const text = '一二三四五六七八九十'.repeat(10);
    const out = truncateToTokens(text, 20);
    expect(out.length).toBeLessThan(text.length);
    expect(estimateTokens(out)).toBeLessThanOrEqual(20);
  });

  it('预算为 0 返回空串', () => {
    expect(truncateToTokens('任何内容', 0)).toBe('');
  });
});
