/**
 * 本地种子数据：一条用户 + 几条中文笔记，用来验证分词、检索、心跳。
 * 用法：pnpm db:seed
 */
import 'dotenv/config';
import { createPool } from './client.js';
import { segmentNote } from '../memory/segment.js';
import { env } from '../config.js';

const NOTES = [
  {
    title: '转岗面试',
    content: '这周开始准备转岗面试，简历改了三版还是觉得项目写得太薄。晚上加班到十点，回家只想躺着。',
  },
  {
    title: '豆豆',
    content: '楼下那只橘猫今天蹭我腿，给它买了罐头。想养一只猫，但房东不让。',
  },
  {
    title: '睡眠',
    content: '最近总是两点才能睡着，早上起不来，白天靠咖啡续命。周末想补觉但更累。',
  },
  {
    title: '和妈妈',
    content: '妈妈打电话问我什么时候回家，我说忙。其实有点想回去吃她做的红烧排骨。',
  },
  {
    title: '读书',
    content: '把《被讨厌的勇气》看完了，里面说"一切烦恼都来自人际关系"，有点被说中。',
  },
];

async function main(): Promise<void> {
  const pool = createPool(env.DATABASE_URL, 2, 'seed');
  try {
    const user = await pool.query<{ id: string }>(
      `insert into users (wechat_openid, nickname)
       values ('seed-openid-001', '小明')
       on conflict (wechat_openid) do update set nickname = excluded.nickname
       returning id`,
    );
    const userId = Number(user.rows[0]?.id);
    if (!userId) throw new Error('seed 用户创建失败');

    await pool.query(`insert into companion_state (user_id) values ($1) on conflict do nothing`, [userId]);

    for (const note of NOTES) {
      const inserted = await pool.query<{ id: string }>(
        `insert into notes (user_id, title, content, content_tokens)
         values ($1, $2, $3, $4)
         returning id`,
        [userId, note.title, note.content, segmentNote(note.title, note.content)],
      );
      const noteId = Number(inserted.rows[0]?.id ?? 0);
      console.log(`note #${noteId} ${note.title} → tokens: ${segmentNote(note.title, note.content)}`);
    }

    console.log(`\nuserId=${userId}`);
    console.log('下一步：pnpm backfill:embeddings 生成向量，再 GET /memory/search?q=最近工作压力大');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
