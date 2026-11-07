CREATE TABLE "runs" (
	"job_id" uuid NOT NULL,
	"run_number" integer NOT NULL,
	"slot" integer,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"failure_kind" text,
	CONSTRAINT "runs_job_id_run_number_pk" PRIMARY KEY("job_id","run_number"),
	CONSTRAINT "runs_outcome_check" CHECK ("runs"."outcome" in ('done', 'pr_open', 'retry', 'failed', 'cancelled')),
	CONSTRAINT "runs_failure_kind_check" CHECK ("runs"."failure_kind" in ('infra', 'agent', 'setup'))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;