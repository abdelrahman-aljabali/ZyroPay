CREATE TABLE "cardano_allowance_spends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allowance_id" uuid NOT NULL,
	"transaction_request_id" uuid NOT NULL,
	"payee" text NOT NULL,
	"lovelace" numeric(78, 0) NOT NULL,
	"tx_hash" text,
	"spent_utxo" text,
	"next_datum" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cardano_allowances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"network" "network" NOT NULL,
	"status" text NOT NULL,
	"owner_address" text NOT NULL,
	"owner_key_hash" text NOT NULL,
	"owner_public_key" text NOT NULL,
	"script_address" text NOT NULL,
	"agent_address" text NOT NULL,
	"agent_key_hash" text NOT NULL,
	"agent_public_key" text NOT NULL,
	"encrypted_agent_key" text NOT NULL,
	"datum" jsonb NOT NULL,
	"payee_addresses" jsonb,
	"fiat" jsonb,
	"budget_lovelace" numeric(78, 0) NOT NULL,
	"float_lovelace" numeric(78, 0) NOT NULL,
	"pending_action" jsonb,
	"create_tx_hash" text,
	"last_tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cardano_allowance_spends" ADD CONSTRAINT "cardano_allowance_spends_allowance_id_cardano_allowances_id_fk" FOREIGN KEY ("allowance_id") REFERENCES "public"."cardano_allowances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cardano_allowance_spends" ADD CONSTRAINT "cardano_allowance_spends_transaction_request_id_transaction_requests_id_fk" FOREIGN KEY ("transaction_request_id") REFERENCES "public"."transaction_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cardano_allowances" ADD CONSTRAINT "cardano_allowances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cardano_allowances" ADD CONSTRAINT "cardano_allowances_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cardano_allowances" ADD CONSTRAINT "cardano_allowances_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cardano_allowance_spends_request_uq" ON "cardano_allowance_spends" USING btree ("transaction_request_id");--> statement-breakpoint
CREATE INDEX "cardano_allowance_spends_allowance_idx" ON "cardano_allowance_spends" USING btree ("allowance_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cardano_allowances_agent_live_uq" ON "cardano_allowances" USING btree ("agent_id") WHERE "cardano_allowances"."status" not in ('revoked', 'failed');--> statement-breakpoint
CREATE INDEX "cardano_allowances_user_idx" ON "cardano_allowances" USING btree ("user_id");