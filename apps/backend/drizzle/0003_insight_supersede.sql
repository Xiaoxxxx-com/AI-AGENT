ALTER TABLE "user_insights" ADD COLUMN "superseded_by" bigint;--> statement-breakpoint
ALTER TABLE "user_insights" ADD COLUMN "superseded_reason" text;--> statement-breakpoint
ALTER TABLE "user_insights" ADD CONSTRAINT "user_insights_superseded_by_user_insights_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."user_insights"("id") ON DELETE no action ON UPDATE no action;