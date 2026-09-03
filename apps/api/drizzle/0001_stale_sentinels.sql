CREATE TYPE "public"."content_visibility" AS ENUM('pending_review', 'published', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."participant_intent" AS ENUM('looking_for_team', 'has_team', 'browsing');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TABLE "event_participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"intent" "participant_intent" DEFAULT 'browsing' NOT NULL,
	"preferred_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"blurb" text DEFAULT '' NOT NULL,
	"blurb_visibility" "content_visibility" DEFAULT 'pending_review' NOT NULL,
	"is_adult" boolean,
	"guardian_consent_confirmed" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email_ciphertext" "bytea" NOT NULL,
	"email_lookup" "bytea" NOT NULL,
	"display_name" text NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_participants_event_user_idx" ON "event_participants" USING btree ("event_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lookup_idx" ON "users" USING btree ("email_lookup");