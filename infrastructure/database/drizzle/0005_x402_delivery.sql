ALTER TABLE "transaction_request_artifacts" ADD COLUMN "x402_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transaction_request_artifacts" ADD COLUMN "x402_http_status" integer;--> statement-breakpoint
ALTER TABLE "transaction_request_artifacts" ADD COLUMN "x402_report" jsonb;