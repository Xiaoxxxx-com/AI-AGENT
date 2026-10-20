/**
 * 生成干扰语料：让 Recall@10 与「关键词路独有命中」两个指标变得有意义。
 *
 * 30 条种子语料小于 candidateLimit(40)，向量路会把全部笔记都取回来，
 * 于是每条关键词命中同时也被向量路命中 → 独有占比恒等于 0，指标失真。
 *
 * 用法：pnpm corpus:distractors [--count=300]
 * 幂等：标题形如「杂记-0001」，重复跑只补缺失的那部分。
 * 注意：干扰语料故意覆盖「工作/妈妈/睡不着」等主题，会真实拉低召回——这才是接近线上分布。
 */
import 'dotenv/config';
import { createPool } from '../apps/backend/src/db/client.js';
import { segmentNote } from '../apps/backend/src/memory/segment.js';
import { env } from '../apps/backend/src/config.js';

const args = process.argv.slice(2);
const COUNT = Number(args.find((a) => a.startsWith('--count='))?.split('=')[1] ?? 300);

const CLAUSES = [
  '早上出门忘带伞，到公司才发现包里有一把',
  '中午和同事去楼下吃了牛肉面，汤有点咸',
  '会开到一半投影仪坏了，大家干坐了二十分钟',
  '把桌面的文件整理了一遍，顺手删了两百多封邮件',
  '下午三点困得厉害，趴在工位上眯了十分钟',
  '地铁上有人在看球赛，全程外放声音',
  '楼下便利店的关东煮涨价了，萝卜从五块变成六块',
  '给阳台的绿萝换了盆，根长得比想象的旺',
  '晚上煮了番茄鸡蛋面，盐放多了',
  '看到一条新闻说今年冬天可能特别冷',
  '整理相册翻到几年前的旅行照片，站在海边笑得很傻',
  '打印机卡纸，弄了半小时才修好',
  '买了个新键盘，敲起来声音比旧的清脆',
  '邻居家装修，电钻从早上八点响到中午',
  '顺手把手机相册清了两千多张截图',
  '在超市看到有卖小时候吃的那种橘子糖',
  '晚上散步路过一家新开的咖啡店，人很多',
  '把上周没看完的纪录片补完了，讲深海生物',
  '窗台的薄荷长疯了，剪了一把泡水',
  '外卖送错了餐，商家退钱还多送了一份小菜',
  '周会上被点名汇报，磕磕巴巴讲完了',
  '空调温度调得太低，穿了两件还是冷',
  '在二手平台卖掉了旧显示器，买家很爽快',
  '路过书店进去翻了半小时，最后只买了支笔',
  '把闹钟调早了二十分钟，结果还是按掉继续睡',
  '雨下了一整天，鞋子湿了半截',
  '午休时听完了整张专辑，意外地喜欢第三首',
  '把冰箱清了一遍，扔掉了过期的酱料',
  '回家路上看到有人在路边卖花，买了一小束',
  '在电梯里遇到隔壁公司的同事，聊了两句天气',
  '手机更新系统后耗电变快了',
  '试着做了个红烧茄子，颜色不太对但味道还行',
  '周五下班路上堵了四十分钟',
  '把书桌挪到窗边，光线好了很多',
  '看了一场线上讲座，讲城市里的鸟',
  '把旧毛巾剪了当抹布，觉得挺划算',
  '早上起来发现阳台的花开了一朵',
  '在便利店买了张刮刮乐，中了五块',
  '给电脑清灰，风扇声音小了不少',
  '整理衣柜时发现一件没穿过几次的外套',
  '同事带了家乡的腊肠来分，味道很冲',
  '把手机屏幕摔了，贴膜救了一命',
  '晚上关灯之后听到楼下有人遛狗聊天',
  '试着早睡，躺下之后还是刷了半小时手机',
  '把积了灰的跑鞋刷干净，想着周末去公园',
  '公司楼下的树被修剪了，一下子显得很空',
  '把上周的会议纪要补完了，写了两页',
  '在冰箱里找到一盒忘了喝的酸奶，日期还早',
  '傍晚下了一阵太阳雨，天边有彩虹',
  '把备用钥匙放回了抽屉，之前找了半天',
];

const TITLES = ['杂记', '随手记', '流水账', '日常', '备忘'];

function buildContent(index: number): string {
  const start = (index * 3) % CLAUSES.length;
  const picked = [0, 1, 2].map((offset) => CLAUSES[(start + offset) % CLAUSES.length]!);
  return `${picked.join('。')}。`;
}

async function main(): Promise<void> {
  const pool = createPool(env.DATABASE_URL, 4, 'distractors');
  try {
    const userRes = await pool.query<{ id: string }>(
      `select id from users where wechat_openid = 'seed-openid-001'`,
    );
    const userId = Number(userRes.rows[0]?.id);
    if (!userId) throw new Error('找不到 seed 用户，先跑 pnpm db:seed');

    const existing = await pool.query<{ title: string }>(`select title from notes where user_id = $1`, [
      userId,
    ]);
    const titles = new Set(existing.rows.map((r) => r.title));

    let inserted = 0;
    for (let i = 1; i <= COUNT; i += 1) {
      const title = `${TITLES[i % TITLES.length]}-${String(i).padStart(4, '0')}`;
      if (titles.has(title)) continue;
      const content = buildContent(i);
      await pool.query(
        `insert into notes (user_id, title, content, content_tokens)
         values ($1, $2, $3, $4)`,
        [userId, title, content, segmentNote(title, content)],
      );
      inserted += 1;
    }

    const total = await pool.query<{ n: number }>(`select count(*)::int as n from notes where user_id = $1`, [
      userId,
    ]);
    console.log(`新增干扰语料 ${inserted} 条，语料总数 ${total.rows[0]?.n}`);
    console.log('下一步：pnpm backfill:embeddings && pnpm eval:retrieval');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
