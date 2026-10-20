import { cut } from '@node-rs/jieba';

/**
 * 中文关键词路的关键：PostgreSQL 内置分词器不切分中文，
 * `to_tsvector('simple', '最近工作压力很大')` 只会产出一个整段 token。
 * 因此必须应用侧用 jieba 切好、空格拼接写进 content_tokens，再由生成列转 tsvector。
 */

const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '也', '就', '都', '而', '及', '与', '着', '或', '被', '把', '让',
  '给', '从', '对', '为', '以', '之', '等', '上', '下', '个', '这', '那', '我', '你', '他', '她',
  '它', '我们', '你们', '他们', '一个', '没有', '什么', '怎么', '因为', '所以', '但是', '如果',
  '还是', '已经', '可以', '这个', '那个', '啊', '吧', '呢', '吗', '呀', '哦', '嗯', '哈',
]);

/** to_tsquery 的操作符必须剔除，否则会造成语法错误甚至注入 */
const TSQUERY_UNSAFE = /[&|!():*'<>\\]/g;
const NON_WORD = /^[\s\p{P}\p{S}]+$/u;

export function tokenize(text: string): string[] {
  if (!text.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of cut(text, false)) {
    const token = raw.trim();
    if (!token || NON_WORD.test(token)) continue;
    if (STOPWORDS.has(token)) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

/** 写入 notes.content_tokens 用 */
export function segment(text: string): string {
  return tokenize(text).join(' ');
}

/** 标题 + 正文一起切，标题命中同样重要 */
export function segmentNote(title: string, content: string): string {
  return segment([title, content].filter(Boolean).join('\n'));
}

/**
 * 拼 to_tsquery 表达式。关键词路要用 OR：AND 会把“最近工作压力大”收得太紧，
 * 只要有一个词没出现就零召回。空查询给一个永不命中的占位词。
 */
export function toTsQuery(text: string): string {
  const tokens = tokenize(text)
    .map((t) => t.replace(TSQUERY_UNSAFE, '').trim())
    .filter(Boolean);
  if (tokens.length === 0) return 'zzzznomatch';
  return tokens.join(' | ');
}
