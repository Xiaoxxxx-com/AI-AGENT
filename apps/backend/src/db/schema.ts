/**
 * Drizzle schema —— 「认知基底」的全部表结构。
 *
 * 约定：
 * 1. 向量维度由 EMBEDDING_DIM 决定（默认 1024，对应 bge-m3）。换模型必须全量重算，不要混维度。
 * 2. `content_tsvector` 是生成列，来源是应用侧分词后的 `content_tokens`（中文必须走 jieba），
 *    不要直接 to_tsvector('simple', content)，PG 内置分词器不切分中文。
 * 3. HNSW / GIN 索引不写在 schema 里，见 drizzle/0002_vector_index.sql（手写更稳）。
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  time,
  timestamp,
  unique,
  uuid,
  vector,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const EMBEDDING_DIM = (() => {
  const raw = Number(process.env.EMBEDDING_DIM ?? 1024);
  return Number.isFinite(raw) && raw > 0 ? raw : 1024;
})();

/** PG 没有内置 tsvector 类型映射，这里自定义一个（只读用途，写入由生成列完成）。 */
const tsvector = customType<{ data: string; notNull: false; default: false }>({
  dataType() {
    return 'tsvector';
  },
});

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    wechatOpenid: text('wechat_openid'),
    unionid: text('unionid'),
    nickname: text('nickname'),
    avatarUrl: text('avatar_url'),
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    quietStart: time('quiet_start').notNull().default('23:00'),
    quietEnd: time('quiet_end').notNull().default('08:00'),
    proactiveEnabled: boolean('proactive_enabled').notNull().default(true),
    dailyProactiveCap: integer('daily_proactive_cap').notNull().default(3),
    subscriptionQuota: integer('subscription_quota').notNull().default(0),
    createdAt,
    updatedAt,
  },
  (t) => [unique('users_wechat_openid_key').on(t.wechatOpenid)],
);

export const notes = pgTable(
  'notes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    content: text('content').notNull(),
    /** 应用侧 jieba 切词结果，空格拼接；修改 content 时必须同步刷新 */
    contentTokens: text('content_tokens'),
    contentTsvector: tsvector('content_tsvector').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(content_tokens, ''))`,
    ),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    embeddingModel: text('embedding_model'),
    embeddingUpdatedAt: timestamp('embedding_updated_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    index('idx_notes_user_time').on(t.userId, t.createdAt.desc()),
    index('idx_notes_tsvector').using('gin', t.contentTsvector),
  ],
);

export const tags = pgTable(
  'tags',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt,
  },
  (t) => [unique('tags_user_name_key').on(t.userId, t.name)],
);

export const noteTags = pgTable(
  'note_tags',
  {
    noteId: bigint('note_id', { mode: 'number' })
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    tagId: bigint('tag_id', { mode: 'number' })
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.noteId, t.tagId] })],
);

export const conversations = pgTable(
  'conversations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // 'user' | 'assistant' | 'system'
    content: text('content').notNull(),
    sessionId: uuid('session_id'),
    tokenCount: integer('token_count'),
    model: text('model'),
    traceId: text('trace_id'),
    createdAt,
  },
  (t) => [index('idx_conv_user_id').on(t.userId, t.id.desc())],
);

export const userInsights = pgTable(
  'user_insights',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    insightType: text('insight_type').notNull(),
    content: text('content').notNull(),
    confidence: real('confidence').notNull().default(0.5),
    /** 证据溯源：只允许引用该用户真实存在的 note */
    sourceNoteIds: bigint('source_note_ids', { mode: 'number' }).array().notNull().default(sql`'{}'::bigint[]`),
    evidence: jsonb('evidence').notNull().default(sql`'[]'::jsonb`),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    isActive: boolean('is_active').notNull().default(true),
    /** 被哪条新洞察取代（冲突下线用）；为 null 表示仍然有效 */
    supersededBy: bigint('superseded_by', { mode: 'number' }).references(
      (): AnyPgColumn => userInsights.id,
    ),
    supersededReason: text('superseded_reason'),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    check(
      'user_insights_type_check',
      sql`${t.insightType} in ('pattern','preference','concern','milestone')`,
    ),
    check('user_insights_confidence_check', sql`${t.confidence} between 0 and 1`),
    index('idx_insights_user_active').on(t.userId, t.isActive).where(sql`is_active = true`),
  ],
);

export const companionState = pgTable(
  'companion_state',
  {
    userId: bigint('user_id', { mode: 'number' })
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    currentMood: text('current_mood').notNull().default('neutral'),
    energy: real('energy').notNull().default(0.7),
    lastUserMessageAt: timestamp('last_user_message_at', { withTimezone: true }),
    lastProactiveAt: timestamp('last_proactive_at', { withTimezone: true }),
    consecutiveIgnored: integer('consecutive_ignored').notNull().default(0),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
    nextHeartbeatAt: timestamp('next_heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    dailyProactiveCount: integer('daily_proactive_count').notNull().default(0),
    dailyCountDate: date('daily_count_date').notNull().defaultNow(),
    /** 乐观锁：心跳与对话同时更新时避免互相覆盖 */
    version: integer('version').notNull().default(0),
    updatedAt,
  },
  (t) => [
    check('companion_state_energy_check', sql`${t.energy} between 0 and 1`),
    index('idx_state_due').on(t.nextHeartbeatAt),
  ],
);

export const proactiveLog = pgTable(
  'proactive_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    triggerType: text('trigger_type').notNull(),
    reason: text('reason').notNull(),
    message: text('message').notNull(),
    urgency: text('urgency').notNull().default('low'),
    status: text('status').notNull().default('queued'),
    channel: text('channel'), // 'subscribe_msg' | 'in_app'
    /** 防重复发送的硬闸门：同一 (user_id, dedupe_key) 只会有一条 */
    dedupeKey: text('dedupe_key').notNull(),
    userReplied: boolean('user_replied'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    subscriptionMsgId: text('subscription_msg_id'),
    createdAt,
  },
  (t) => [
    check(
      'proactive_log_trigger_check',
      sql`${t.triggerType} in ('note_triggered','idle_checkin','milestone')`,
    ),
    check('proactive_log_urgency_check', sql`${t.urgency} in ('low','medium','high')`),
    check(
      'proactive_log_status_check',
      sql`${t.status} in ('queued','sent','failed','read','expired')`,
    ),
    unique('proactive_log_user_dedupe_key').on(t.userId, t.dedupeKey),
    index('idx_proactive_user_time').on(t.userId, t.createdAt.desc()),
    index('idx_proactive_pending')
      .on(t.userId)
      .where(sql`status = 'sent' and read_at is null`),
  ],
);

export const conversationSummaries = pgTable(
  'conversation_summaries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull(),
    coversFromId: bigint('covers_from_id', { mode: 'number' }).notNull(),
    coversToId: bigint('covers_to_id', { mode: 'number' }).notNull(),
    summary: text('summary').notNull(),
    tokenCount: integer('token_count').notNull(),
    supersededBy: bigint('superseded_by', { mode: 'number' }).references(
      (): AnyPgColumn => conversationSummaries.id,
    ),
    createdAt,
  },
  (t) => [index('idx_summary_user_session').on(t.userId, t.sessionId, t.coversToId.desc())],
);

export type User = typeof users.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
export type Insight = typeof userInsights.$inferSelect;
export type CompanionStateRow = typeof companionState.$inferSelect;
export type ProactiveLogRow = typeof proactiveLog.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationSummary = typeof conversationSummaries.$inferSelect;
