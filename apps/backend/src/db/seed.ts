/**
 * 本地种子数据：一个用户 + 30 条中文笔记，用来验证分词、混合检索、摘要与心跳。
 * 标题在语料里唯一——检索评测（scripts/eval-retrieval.ts）靠标题标注意图，不要随意改。
 * 用法：pnpm db:seed（幂等：按标题跳过已存在的）
 */
import 'dotenv/config';
import { createPool } from './client.js';
import { segmentNote } from '../memory/segment.js';
import { env } from '../config.js';

const NOTES = [
  { title: '转岗面试', content: '这周开始准备转岗面试，简历改了三版还是觉得项目写得太薄。晚上加班到十点，回家只想躺着。' },
  { title: '豆豆', content: '楼下那只橘猫今天蹭我腿，给它买了罐头。想养一只猫，但房东不让。' },
  { title: '睡眠', content: '最近总是两点才能睡着，早上起不来，白天靠咖啡续命。周末想补觉但更累。' },
  { title: '和妈妈', content: '妈妈打电话问我什么时候回家，我说忙。其实有点想回去吃她做的红烧排骨。' },
  { title: '读书', content: '把《被讨厌的勇气》看完了，里面说"一切烦恼都来自人际关系"，有点被说中。' },
  { title: '加班', content: '这周三又加到十一点，回家地铁上站着就睡着了。项目上线前一星期都这样。' },
  { title: '部门调整', content: '领导说下个月组织架构要变，我们组可能被拆。大家都在私下打听，气氛很怪。' },
  { title: '体检', content: '体检报告出来了，轻度脂肪肝，医生说少喝酒多运动。今年应酬确实多。' },
  { title: '跑步', content: '开始夜跑，第一次只跑了两公里就喘。坚持了四天，小腿有点酸。' },
  { title: '房租', content: '房东说要涨租五百，理由是附近地铁开通了。我在想要不要搬到远一点的地方。' },
  { title: '存款', content: '算了下存款，离首付还差很远。按现在的存钱速度，还得四五年。' },
  { title: '老朋友', content: '大学室友结婚，请我当伴郎。看着他爸妈在台上说话，我居然有点想哭。' },
  { title: '咖啡', content: '一天三杯美式，下午心跳有点快，手也发抖。可能该减到一杯了。' },
  { title: '想养猫', content: '又去看了一次领养信息，那只三花很亲人。但出差的时候没人照顾。' },
  { title: '妈妈的手术', content: '妈妈膝盖要做个小手术，下周住院。她说不用我回去，我还是请了假。' },
  { title: '周末', content: '周末在家躺了两天，外卖吃了三顿，什么也没干，反而更空。' },
  { title: '面试失败', content: '那家公司委婉拒了，说岗位匹配度不够。挂了电话在楼梯间站了十分钟。' },
  { title: '简历', content: '又改了一版简历，把项目里的数据补上了。投了七家，回了两家。' },
  { title: '童年', content: '小时候在奶奶家过暑假，中午睡竹床，蝉一直在叫。那时候觉得时间特别长。' },
  { title: '焦虑', content: '半夜会突然心慌，坐起来喝水，脑子停不下来，想的都是工作的事。' },
  { title: '同事', content: '和小李吃了饭，他说也想走，但房贷压着不敢动。我们俩都没再说话。' },
  { title: '学英语', content: '报了个口语班，每周两次，晚上八点。第一节课全程没敢开口。' },
  { title: '电影', content: '看了《年会不能停》，笑得挺开心，出来又觉得有点酸。' },
  { title: '生日', content: '生日那天一个人吃了碗面，加了个蛋。妈妈视频过来唱生日歌，我说挺好的。' },
  { title: '加班费', content: 'HR 说加班费按调休算，可我们组根本排不开。算下来一个月白干十几个小时。' },
  { title: '颈椎', content: '脖子疼了半个月，去按摩了一次，师傅说我这颈椎像四十岁的。' },
  { title: '旅行', content: '想十一去云南，看了下机票，往返两千三。在犹豫要不要一个人去。' },
  { title: '姐姐', content: '姐姐生了孩子，发来照片，小小一只。突然觉得自己也到了要给红包的年纪。' },
  { title: '断舍离', content: '扔了两大袋衣服，包括那件一直没穿过的西装。房间空了一点，心里也是。' },
  { title: '深夜', content: '凌晨两点还醒着，刷手机刷到眼睛疼。知道该睡了，就是不想放下。' },
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

    const existing = await pool.query<{ title: string }>(`select title from notes where user_id = $1`, [
      userId,
    ]);
    const existingTitles = new Set(existing.rows.map((r) => r.title));

    let inserted = 0;
    for (const note of NOTES) {
      if (existingTitles.has(note.title)) continue;
      const res = await pool.query<{ id: string }>(
        `insert into notes (user_id, title, content, content_tokens)
         values ($1, $2, $3, $4)
         returning id`,
        [userId, note.title, note.content, segmentNote(note.title, note.content)],
      );
      inserted += 1;
      console.log(`  #${res.rows[0]?.id} ${note.title}`);
    }

    console.log(`\n新增 ${inserted} 条，跳过 ${NOTES.length - inserted} 条已存在 · userId=${userId}`);
    console.log('下一步：pnpm backfill:embeddings → pnpm eval:retrieval');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
