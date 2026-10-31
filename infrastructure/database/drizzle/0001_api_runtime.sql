CREATE TABLE "incoming_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"network" "network" NOT NULL,
	"tx_hash" text NOT NULL,
	"asset_id" text NOT NULL,
	"from_address" text,
	"to_address" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"provider" text NOT NULL,
	"webhook_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incoming_transfers_amount_ck" CHECK (amount >= 0)
);
--> statement-breakpoint
CREATE TABLE "login_stamp_replays" (
	"stamp_hash" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "login_stamp_replays_hash_ck" CHECK (stamp_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "notification_dispatches" (
	"dedupe_key" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notification_dispatches_status_ck" CHECK (status IN ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "onramp_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"quote_id" text NOT NULL,
	"session_id" text,
	"order_id" text,
	"network" "network" NOT NULL,
	"asset_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"status" text DEFAULT 'quoted' NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"quote_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onramp_orders_status_ck" CHECK (status IN ('quoted', 'session_created', 'processing', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "rate_limit_counters" (
	"bucket_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_counters_pk" PRIMARY KEY("bucket_key","window_start")
);
--> statement-breakpoint
CREATE TABLE "session_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "session_access_tokens_hash_ck" CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "transaction_request_artifacts" (
	"transaction_request_id" uuid PRIMARY KEY NOT NULL,
	"unsigned_valid_until" timestamp with time zone,
	"unsigned_built_at" timestamp with time zone,
	"estimated_fee" numeric(78, 0),
	"signed_transaction" text,
	"signed_encoding" text,
	"turnkey_activity_id" text,
	"signed_at" timestamp with time zone,
	"broadcast_attempts" integer DEFAULT 0 NOT NULL,
	"confirm_attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_request_artifacts_encoding_ck" CHECK (signed_encoding IS NULL OR signed_encoding IN ('base64', 'hex'))
);
--> statement-breakpoint
ALTER TABLE "incoming_transfers" ADD CONSTRAINT "incoming_transfers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_transfers" ADD CONSTRAINT "incoming_transfers_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_transfers" ADD CONSTRAINT "incoming_transfers_webhook_event_id_webhook_events_id_fk" FOREIGN KEY ("webhook_event_id") REFERENCES "public"."webhook_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_dispatches" ADD CONSTRAINT "notification_dispatches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onramp_orders" ADD CONSTRAINT "onramp_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onramp_orders" ADD CONSTRAINT "onramp_orders_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_access_tokens" ADD CONSTRAINT "session_access_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_access_tokens" ADD CONSTRAINT "session_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_request_artifacts" ADD CONSTRAINT "transaction_request_artifacts_request_fk" FOREIGN KEY ("transaction_request_id") REFERENCES "public"."transaction_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_transfers_uq" ON "incoming_transfers" USING btree ("network","tx_hash","to_address","asset_id");--> statement-breakpoint
CREATE INDEX "incoming_transfers_user_idx" ON "incoming_transfers" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "login_stamp_replays_expires_idx" ON "login_stamp_replays" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "onramp_orders_provider_quote_uq" ON "onramp_orders" USING btree ("provider","quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onramp_orders_provider_order_uq" ON "onramp_orders" USING btree ("provider","order_id") WHERE "onramp_orders"."order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "onramp_orders_user_idx" ON "onramp_orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "rate_limit_counters_window_idx" ON "rate_limit_counters" USING btree ("window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "session_access_tokens_hash_uq" ON "session_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "session_access_tokens_session_idx" ON "session_access_tokens" USING btree ("session_id");