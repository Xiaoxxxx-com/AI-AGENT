import { describe, expect, it } from 'vitest';
import { fuseRrf } from '../apps/backend/src/memory/hybrid-search';

describe('RRF 融合', () => {
  it('两路命中的文档分数叠加', () => {
    const fused = fuseRrf([1, 2], [2, 3]);
    const byId = new Map(fused.map((f) => [f.id, f]));

    // id2：向量第 2 名 + 关键词第 1 名
    expect(byId.get(2)?.score).toBeCloseTo(1 / 62 + 1 / 61, 6);
    // id1：只有向量第 1 名
    expect(byId.get(1)?.score).toBeCloseTo(1 / 61, 6);

    expect(byId.get(2)?.fromVector).toBe(true);
    expect(byId.get(2)?.fromKeyword).toBe(true);
    expect(byId.get(3)?.fromVector).toBe(false);
    expect(byId.get(3)?.fromKeyword).toBe(true);
  });

  it('结果按分数降序，且两路都命中的排在前面', () => {
    const fused = fuseRrf([10, 20, 30], [30, 20, 10]);
    expect(fused[0]?.id).toBe(30);
    expect(fused.map((f) => f.id).sort()).toEqual([10, 20, 30]);
    for (let i = 1; i < fused.length; i += 1) {
      expect(fused[i - 1]!.score).toBeGreaterThanOrEqual(fused[i]!.score);
    }
  });

  it('单路为空时退化为另一路的排序', () => {
    expect(fuseRrf([7, 8], []).map((f) => f.id)).toEqual([7, 8]);
    expect(fuseRrf([], [9, 8]).map((f) => f.id)).toEqual([9, 8]);
  });

  it('两路都空返回空数组', () => {
    expect(fuseRrf([], [])).toEqual([]);
  });

  it('分数相同时按 id 降序，保证顺序稳定', () => {
    const a = fuseRrf([5], [6]);
    const b = fuseRrf([5], [6]);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(a[0]?.id).toBe(6);
  });

  it('k 越小，头部排名差异放大', () => {
    const small = fuseRrf([1, 2], [], 1);
    const large = fuseRrf([1, 2], [], 60);
    const gapSmall = small[0]!.score - small[1]!.score;
    const gapLarge = large[0]!.score - large[1]!.score;
    expect(gapSmall).toBeGreaterThan(gapLarge);
  });
});
