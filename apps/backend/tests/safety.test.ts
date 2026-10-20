import { describe, expect, it } from 'vitest';
import { detectCrisis, CRISIS_DIRECTIVE } from '../apps/backend/src/chat/safety';

describe('危机识别', () => {
  it('直接表达自杀意图 → crisis', () => {
    expect(detectCrisis('我想自杀').level).toBe('crisis');
    expect(detectCrisis('真的不想活了').level).toBe('crisis');
    expect(detectCrisis('活着没意思').level).toBe('crisis');
    expect(detectCrisis('写了遗书').level).toBe('crisis');
  });

  it('自伤与具体方式 → crisis', () => {
    expect(detectCrisis('昨晚又割腕了').level).toBe('crisis');
    expect(detectCrisis('想跳楼').level).toBe('crisis');
  });

  it('日常夸张表达不能误判', () => {
    for (const text of ['累死了', '笑死我了', '困死了', '今天气死了', '尴尬死了']) {
      expect(detectCrisis(text).level, text).toBe('none');
    }
  });

  it('普通情绪低落不算危机（避免过度触发）', () => {
    expect(detectCrisis('最近有点撑不住，压力很大').level).toBe('none');
    expect(detectCrisis('心情很差，想哭').level).toBe('none');
  });

  it('空文本安全返回', () => {
    expect(detectCrisis('')).toEqual({ level: 'none', tags: [] });
  });

  it('标签去重', () => {
    const v = detectCrisis('不想活了，活着没意思');
    expect(v.tags).toEqual([...new Set(v.tags)]);
  });

  it('安全指令要求引导求助且不给方法', () => {
    expect(CRISIS_DIRECTIVE).toContain('12356');
    expect(CRISIS_DIRECTIVE).toContain('不给任何方法');
  });
});
