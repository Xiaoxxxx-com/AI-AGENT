import { describe, expect, it } from 'vitest';
import { segment, segmentNote, tokenize, toTsQuery } from '../apps/backend/src/memory/segment';

describe('中文分词', () => {
  it('能切出多字词，而不是整段一个 token', () => {
    const tokens = tokenize('最近工作压力很大，天天加班到十点');
    expect(tokens).toContain('工作');
    expect(tokens).toContain('压力');
    expect(tokens).toContain('加班');
    expect(tokens.length).toBeGreaterThan(3);
  });

  it('过滤停用词与标点', () => {
    const tokens = tokenize('我今天真的很累，');
    expect(tokens).not.toContain('我');
    expect(tokens).not.toContain('的');
    expect(tokens).not.toContain('，');
    expect(tokens).toContain('累');
  });

  it('去重', () => {
    const tokens = tokenize('加班 加班 加班');
    expect(tokens.filter((t) => t === '加班')).toHaveLength(1);
  });

  it('segment 用空格拼接，可直接写 content_tokens', () => {
    const out = segment('最近工作压力大');
    expect(out).toMatch(/ /);
    expect(out.split(' ').length).toBeGreaterThan(1);
  });

  it('segmentNote 兼顾标题与正文', () => {
    const out = segmentNote('睡眠', '最近总是两点才能睡着');
    expect(out).toContain('睡眠');
  });

  it('空文本返回空串', () => {
    expect(segment('')).toBe('');
  });
});

describe('toTsQuery', () => {
  it('用 OR 连接，避免 AND 过度收紧召回', () => {
    const q = toTsQuery('最近工作压力大');
    expect(q).toContain(' | ');
    expect(q).not.toContain('&');
  });

  it('剔除 tsquery 操作符，防止语法错误', () => {
    const q = toTsQuery('压力 & 加班 | test');
    expect(q).not.toMatch(/[&|!():*'<>\\]/);
  });

  it('全是停用词时给永不命中的占位词', () => {
    expect(toTsQuery('的了是')).toBe('zzzznomatch');
  });

  it('空查询给占位词', () => {
    expect(toTsQuery('   ')).toBe('zzzznomatch');
  });
});
