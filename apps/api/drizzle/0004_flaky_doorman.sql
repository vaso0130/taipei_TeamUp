CREATE TYPE "public"."risk_level" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TABLE "moderation_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"content_sha256" text NOT NULL,
	"risk_level" "risk_level" NOT NULL,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"model_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"decided_by" text NOT NULL,
	"subject_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "moderation_records" ADD CONSTRAINT "moderation_records_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_records_target_idx" ON "moderation_records" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "moderation_records_subject_idx" ON "moderation_records" USING btree ("subject_user_id","created_at");