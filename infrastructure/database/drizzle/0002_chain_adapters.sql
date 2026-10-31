CREATE TABLE "provider_credentials" (
	"provider" text PRIMARY KEY NOT NULL,
	"encrypted_value" text NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transaction_request_artifacts" ADD COLUMN "signing_kind" text DEFAULT 'transaction' NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_request_artifacts" ADD COLUMN "unsigned_meta" jsonb;--> statement-breakpoint
ALTER TABLE "transaction_request_artifacts" ADD COLUMN "typed_data" jsonb;--> statement-breakpoint
ALTER TABLE "transaction_request_artifacts" ADD COLUMN "evm_nonce" integer;--> statement-breakpoint
ALTER TABLE "transaction_request_artifacts" ADD COLUMN "expected_tx_hash" text;--> statement-breakpoint
CREATE INDEX "transaction_request_artifacts_evm_nonce_idx" ON "transaction_request_artifacts" USING btree ("evm_nonce") WHERE "transaction_request_artifacts"."evm_nonce" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_request_artifacts" ADD CONSTRAINT "transaction_request_artifacts_signing_kind_ck" CHECK (signing_kind IN ('transaction', 'typed_data'));