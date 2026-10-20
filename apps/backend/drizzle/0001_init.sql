CREATE TABLE "companion_state" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"current_mood" text DEFAULT 'neutral' NOT NULL,
	"energy" real DEFAULT 0.7 NOT NULL,
	"last_user_message_at" timestamp with time zone,
	"last_proactive_at" timestamp with time zone,
	"consecutive_ignored" integer DEFAULT 0 NOT NULL,
	"cooldown_until" timestamp with time zone,
	"next_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"daily_proactive_count" integer DEFAULT 0 NOT NULL,
	"daily_count_date" date DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companion_state_energy_check" CHECK ("companion_state"."energy" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "conversation_summaries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"session_id" uuid NOT NULL,
	"covers_from_id" bigint NOT NULL,
	"covers_to_id" bigint NOT NULL,
	"summary" text NOT NULL,
	"token_count" integer NOT NULL,
	"superseded_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"session_id" uuid,
	"token_count" integer,
	"model" text,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_tags" (
	"note_id" bigint NOT NULL,
	"tag_id" bigint NOT NULL,
	CONSTRAINT "note_tags_note_id_tag_id_pk" PRIMARY KEY("note_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"content_tokens" text,
	"content_tsvector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content_tokens, ''))) STORED,
	"embedding" vector(1024),
	"embedding_model" text,
	"embedding_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proactive_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"trigger_type" text NOT NULL,
	"reason" text NOT NULL,
	"message" text NOT NULL,
	"urgency" text DEFAULT 'low' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"channel" text,
	"dedupe_key" text NOT NULL,
	"user_replied" boolean,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"subscription_msg_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proactive_log_user_dedupe_key" UNIQUE("user_id","dedupe_key"),
	CONSTRAINT "proactive_log_trigger_check" CHECK ("proactive_log"."trigger_type" in ('note_triggered','idle_checkin','milestone')),
	CONSTRAINT "proactive_log_urgency_check" CHECK ("proactive_log"."urgency" in ('low','medium','high')),
	CONSTRAINT "proactive_log_status_check" CHECK ("proactive_log"."status" in ('queued','sent','failed','read','expired'))
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_user_name_key" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "user_insights" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"insight_type" text NOT NULL,
	"content" text NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"source_note_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" vector(1024),
	"is_active" boolean DEFAULT true NOT NULL,
	"last_validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_insights_type_check" CHECK ("user_insights"."insight_type" in ('pattern','preference','concern','milestone')),
	CONSTRAINT "user_insights_confidence_check" CHECK ("user_insights"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"wechat_openid" text,
	"unionid" text,
	"nickname" text,
	"avatar_url" text,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"quiet_start" time DEFAULT '23:00' NOT NULL,
	"quiet_end" time DEFAULT '08:00' NOT NULL,
	"proactive_enabled" boolean DEFAULT true NOT NULL,
	"daily_proactive_cap" integer DEFAULT 3 NOT NULL,
	"subscription_quota" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_wechat_openid_key" UNIQUE("wechat_openid")
);
--> statement-breakpoint
ALTER TABLE "companion_state" ADD CONSTRAINT "companion_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_superseded_by_conversation_summaries_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."conversation_summaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_tags" ADD CONSTRAINT "note_tags_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_tags" ADD CONSTRAINT "note_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_log" ADD CONSTRAINT "proactive_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_insights" ADD CONSTRAINT "user_insights_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_state_due" ON "companion_state" USING btree ("next_heartbeat_at");--> statement-breakpoint
CREATE INDEX "idx_summary_user_session" ON "conversation_summaries" USING btree ("user_id","session_id","covers_to_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_conv_user_id" ON "conversations" USING btree ("user_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_notes_user_time" ON "notes" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_notes_tsvector" ON "notes" USING gin ("content_tsvector");--> statement-breakpoint
CREATE INDEX "idx_proactive_user_time" ON "proactive_log" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_proactive_pending" ON "proactive_log" USING btree ("user_id") WHERE status = 'sent' and read_at is null;--> statement-breakpoint
CREATE INDEX "idx_insights_user_active" ON "user_insights" USING btree ("user_id","is_active") WHERE is_active = true;