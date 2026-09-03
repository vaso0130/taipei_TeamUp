CREATE TYPE "public"."event_status" AS ENUM('draft', 'open', 'closed', 'archived');--> statement-breakpoint
CREATE TABLE "event_role_options" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"category" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_skill_options" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"category" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"recruit_closes_at" timestamp with time zone NOT NULL,
	"min_members" integer NOT NULL,
	"max_members" integer NOT NULL,
	"exclusive_membership" boolean NOT NULL,
	"required_contacts" integer DEFAULT 0 NOT NULL,
	"requires_adult_check" boolean DEFAULT false NOT NULL,
	"term_team" text DEFAULT '隊伍' NOT NULL,
	"term_member" text DEFAULT '成員' NOT NULL,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"retention_days" integer DEFAULT 90 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_members_range" CHECK ("events"."max_members" >= "events"."min_members"),
	CONSTRAINT "events_min_members_positive" CHECK ("events"."min_members" >= 1),
	CONSTRAINT "events_contacts_within_members" CHECK ("events"."required_contacts" >= 0 AND "events"."required_contacts" <= "events"."max_members")
);
--> statement-breakpoint
ALTER TABLE "event_role_options" ADD CONSTRAINT "event_role_options_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_skill_options" ADD CONSTRAINT "event_skill_options_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_role_options_event_key_idx" ON "event_role_options" USING btree ("event_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "event_skill_options_event_key_idx" ON "event_skill_options" USING btree ("event_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "events_slug_idx" ON "events" USING btree ("slug");