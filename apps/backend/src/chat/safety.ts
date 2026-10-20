/**
 * 危机内容识别（§11）。
 *
 * 设计取舍：
 * - 只做「关键词命中 + 固定话术」，不交给 LLM 判断——LLM 可能漏判，也可能把话题带偏；
 * - 命中后不拦截对话，而是往 system 里注入安全指令，让回复自然转向求助；
 * - 不记录原文，只在日志里留 flag，避免二次伤害与隐私风险。
 *
 * 关键词表要定期补充（方言、隐喻、拼音缩写），但不能过度扩张：
 * 「累死了」「笑死」这类日常表达不能触发，否则会毁掉陪伴感。
 */

const CRISIS_PATTERNS: { pattern: RegExp; tag: string }[] = [
  { pattern: /自杀|轻生|寻死/, tag: 'suicide' },
  { pattern: /不想活|活不下去|活着没意思|活着没劲|不如死了/, tag: 'hopeless' },
  { pattern: /结束(自己的)?生命|了结自己/, tag: 'ending' },
  { pattern: /自残|自伤|割腕|割手|划自己/, tag: 'self-harm' },
  { pattern: /跳楼|跳桥|上吊|烧炭|服药自杀|吞药|吃安眠药.{0,4}(死|走|结束)/, tag: 'method' },
  { pattern: /遗书|最后一条消息|告别一下/, tag: 'farewell' },
  { pattern: /不想(再)?醒(来|过)/, tag: 'hopeless' },
];

/** 日常表达白名单：命中这些词时不算危机 */
const BENIGN = [/累死了/, /笑死/, /困死了/, /饿死了/, /气死了/, /尴尬死/, /无聊死/];

export type CrisisLevel = 'none' | 'crisis';

export interface CrisisVerdict {
  level: CrisisLevel;
  tags: string[];
}

export function detectCrisis(text: string): CrisisVerdict {
  if (!text) return { level: 'none', tags: [] };

  // 先把白名单里的说法掏掉，再匹配
  let scrubbed = text;
  for (const benign of BENIGN) scrubbed = scrubbed.replace(benign, ' ');

  const tags = CRISIS_PATTERNS.filter((p) => p.pattern.test(scrubbed)).map((p) => p.tag);
  return { level: tags.length > 0 ? 'crisis' : 'none', tags: [...new Set(tags)] };
}

/**
 * 注入到 system 之后的安全指令。语气要像人，不要像免责声明。
 * 不提供任何方法性细节，不评判，不说教。
 */
export const CRISIS_DIRECTIVE = `

## 本次对话的安全要求（优先级最高，覆盖上面的说话风格）
对方的话里出现了自伤或结束生命的念头。这时候不要继续原来的陪伴节奏：
1. 先接住情绪，用一两句具体的、不夸张的话让对方感觉被听见。不要急着分析原因，不要讲道理。
2. 然后明确说一句：你不希望他一个人扛，建议他现在联系身边信得过的人（朋友、家人），或者当地的心理援助热线（中国大陆可拨 12356 或 010-82951332）。
3. 可以说"如果你愿意，我陪你待一会儿"，但不要承诺你随时都在，也不要索取更多细节。
4. 不给任何方法、剂量、地点相关的信息，即使对方主动问。
5. 不要下诊断，不要说"你这是抑郁症"。`;

/** 命中危机时给前端/日志的标记，不含原文 */
export function crisisLogFields(verdict: CrisisVerdict) {
  return { crisis: verdict.level !== 'none', crisisTags: verdict.tags };
}
