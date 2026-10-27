CREATE TABLE "job_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"failure_kind" text,
	"reason" text,
	"data" jsonb,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"identifier" text NOT NULL,
	"item" jsonb NOT NULL,
	"state" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"next_run_at" timestamp with time zone,
	"failure_kind" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "jobs_state_check" CHECK ("jobs"."state" in ('proposed', 'declined', 'queued', 'claiming', 'running', 'pr_open', 'in_review', 'changes_requested', 'merged', 'done', 'failed', 'cancelled')),
	CONSTRAINT "jobs_failure_kind_check" CHECK ("jobs"."failure_kind" in ('infra', 'agent', 'setup'))
);
--> statement-breakpoint
CREATE TABLE "pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "pending_actions_status_check" CHECK ("pending_actions"."status" in ('pending', 'approved', 'rejected', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "slots" (
	"slot" integer PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	CONSTRAINT "slots_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_events_job_id_id_idx" ON "job_events" USING btree ("job_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_source_external_id_key" ON "jobs" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "jobs_state_idx" ON "jobs" USING btree ("state");