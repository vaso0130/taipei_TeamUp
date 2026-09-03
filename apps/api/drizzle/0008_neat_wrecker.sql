ALTER TABLE "event_participants" ADD COLUMN "custom_tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "max_custom_tags" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "custom_tag_max_length" integer DEFAULT 16 NOT NULL;