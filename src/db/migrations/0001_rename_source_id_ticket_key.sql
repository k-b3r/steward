ALTER TABLE "jobs" RENAME COLUMN "external_id" TO "source_id";--> statement-breakpoint
ALTER TABLE "jobs" RENAME COLUMN "identifier" TO "ticket_key";--> statement-breakpoint
DROP INDEX "jobs_source_external_id_key";--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_source_source_id_key" ON "jobs" USING btree ("source","source_id");--> statement-breakpoint
UPDATE "jobs" SET "item" = ("item" - 'externalId' - 'identifier') || jsonb_build_object('sourceId', "item"->'externalId', 'ticketKey', "item"->'identifier') WHERE "item" ? 'externalId';
