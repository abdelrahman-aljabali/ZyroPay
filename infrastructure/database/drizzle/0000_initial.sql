CREATE TYPE "public"."actor_type" AS ENUM('user', 'agent', 'system', 'mcp', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."agent_mode" AS ENUM('always_ask', 'autonomous');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('passkey', 'email_otp', 'oauth_google', 'oauth_apple');--> statement-breakpoint
CREATE TYPE "public"."chain_family" AS ENUM('solana', 'evm');--> statement-breakpoint
CREATE TYPE "public"."chain_tx_status" AS ENUM('pending', 'confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."agent_connection_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."delegated_signer_status" AS ENUM('pending', 'active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."network" AS ENUM('solana-mainnet', 'solana-devnet', 'ethereum-mainnet', 'ethereum-sepolia', 'base-mainnet', 'base-sepolia');--> statement-breakpoint
CREATE TYPE "public"."policy_decision" AS ENUM('allow', 'require_approval', 'deny');--> statement-breakpoint
CREATE TYPE "public"."request_source" AS ENUM('app_send', 'send', 'swap', 'pay_x402');--> statement-breakpoint
CREATE TYPE "public"."requester_type" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('active', 'settled', 'released');--> statement-breakpoint
CREATE TYPE "public"."token_kind" AS ENUM('access_token', 'refresh_token', 'authorization_code');--> statement-breakpoint
CREATE TYPE "public"."tx_request_state" AS ENUM('CREATED', 'POLICY_CHECK', 'PENDING_APPROVAL', 'APPROVED', 'SIGNING', 'BROADCAST', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "agent_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_code" text NOT NULL,
	"oauth_client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"client_uri" text,
	"redirect_uri" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"status" "agent_connection_status" DEFAULT 'pending' NOT NULL,
	"user_id" uuid,
	"agent_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_policies" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"mode" "agent_mode" DEFAULT 'always_ask' NOT NULL,
	"spending_enabled" boolean DEFAULT false NOT NULL,
	"allowed_wallet_ids" jsonb NOT NULL,
	"allowed_networks" jsonb NOT NULL,
	"allowed_tools" jsonb NOT NULL,
	"restrict_recipients" boolean DEFAULT true NOT NULL,
	"recipient_allowlist" jsonb NOT NULL,
	"allowed_protocols" jsonb NOT NULL,
	"per_transaction_usd_minor" numeric(38, 0) DEFAULT '0' NOT NULL,
	"daily_usd_minor" numeric(38, 0) DEFAULT '0' NOT NULL,
	"monthly_usd_minor" numeric(38, 0) DEFAULT '0' NOT NULL,
	"over_limit_behavior" text DEFAULT 'require_approval' NOT NULL,
	"session_expires_at" timestamp with time zone,
	"revoked" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_policies_limits_nonneg_ck" CHECK ("agent_policies"."per_transaction_usd_minor" >= 0 AND "agent_policies"."daily_usd_minor" >= 0 AND "agent_policies"."monthly_usd_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"oauth_client_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"payload_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"rejection_reason" text,
	"turnkey_activity_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_requests_payload_hash_ck" CHECK (payload_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"request_id" text,
	"ip_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"provider_subject" text NOT NULL,
	"turnkey_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "delegated_signers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"turnkey_user_id" text NOT NULL,
	"api_public_key" text NOT NULL,
	"encrypted_api_private_key" text NOT NULL,
	"turnkey_policy_ids" jsonb NOT NULL,
	"status" "delegated_signer_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "executed_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_request_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"network" "network" NOT NULL,
	"tx_hash" text NOT NULL,
	"status" "chain_tx_status" DEFAULT 'pending' NOT NULL,
	"block_number" numeric(20, 0),
	"fee_paid" numeric(78, 0),
	"turnkey_activity_id" text,
	"simulated" boolean DEFAULT false NOT NULL,
	"broadcast_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expo_push_token" text NOT NULL,
	"platform" "device_platform" NOT NULL,
	"device_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"client_uri" text,
	"logo_uri" text,
	"redirect_uris" jsonb NOT NULL,
	"token_endpoint_auth_method" text NOT NULL,
	"client_secret_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"oauth_client_id" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"risk_category" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"rotated_from_id" uuid,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_refresh_token_hash_ck" CHECK (refresh_token_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "spending_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"transaction_request_id" uuid NOT NULL,
	"amount_usd_minor" numeric(38, 0) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spending_ledger_amount_ck" CHECK ("spending_ledger"."amount_usd_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "spending_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"transaction_request_id" uuid NOT NULL,
	"amount_usd_minor" numeric(38, 0) NOT NULL,
	"status" "reservation_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "spending_reservations_amount_ck" CHECK ("spending_reservations"."amount_usd_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "token_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" "token_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "token_records_hash_ck" CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "transaction_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"agent_id" uuid,
	"requester_type" "requester_type" NOT NULL,
	"source" "request_source" NOT NULL,
	"network" "network" NOT NULL,
	"state" "tx_request_state" DEFAULT 'CREATED' NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"valuation_usd_minor" numeric(38, 0),
	"policy_decision" "policy_decision",
	"policy_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_version" integer,
	"unsigned_transaction" text,
	"unsigned_transaction_encoding" text,
	"tx_hash" text,
	"failure_reason" text,
	"simulated" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_requests_payload_hash_ck" CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "transaction_requests_agent_requester_ck" CHECK (("transaction_requests"."requester_type" = 'agent') = ("transaction_requests"."agent_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "user_plugin_settings" (
	"user_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_plugin_settings_user_id_plugin_id_pk" PRIMARY KEY("user_id","plugin_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"display_name" text,
	"turnkey_sub_organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wallet_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"family" "chain_family" NOT NULL,
	"address" text NOT NULL,
	"derivation_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"turnkey_wallet_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_transaction_request_id_transaction_requests_id_fk" FOREIGN KEY ("transaction_request_id") REFERENCES "public"."transaction_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_signers" ADD CONSTRAINT "delegated_signers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executed_transactions" ADD CONSTRAINT "executed_transactions_transaction_request_id_transaction_requests_id_fk" FOREIGN KEY ("transaction_request_id") REFERENCES "public"."transaction_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executed_transactions" ADD CONSTRAINT "executed_transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_devices" ADD CONSTRAINT "notification_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_ledger" ADD CONSTRAINT "spending_ledger_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_ledger" ADD CONSTRAINT "spending_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_ledger" ADD CONSTRAINT "spending_ledger_transaction_request_id_transaction_requests_id_fk" FOREIGN KEY ("transaction_request_id") REFERENCES "public"."transaction_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_reservations" ADD CONSTRAINT "spending_reservations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_reservations" ADD CONSTRAINT "spending_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_reservations" ADD CONSTRAINT "spending_reservations_transaction_request_id_transaction_requests_id_fk" FOREIGN KEY ("transaction_request_id") REFERENCES "public"."transaction_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_records" ADD CONSTRAINT "token_records_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_requests" ADD CONSTRAINT "transaction_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_requests" ADD CONSTRAINT "transaction_requests_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_requests" ADD CONSTRAINT "transaction_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_plugin_settings" ADD CONSTRAINT "user_plugin_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_plugin_settings" ADD CONSTRAINT "user_plugin_settings_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_addresses" ADD CONSTRAINT "wallet_addresses_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_connections_pending_code_uq" ON "agent_connections" USING btree ("user_code") WHERE "agent_connections"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "agents_user_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_tx_request_uq" ON "approval_requests" USING btree ("transaction_request_id");--> statement-breakpoint
CREATE INDEX "approval_requests_user_status_idx" ON "approval_requests" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_user_time_idx" ON "audit_logs" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_time_idx" ON "audit_logs" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_subject_uq" ON "auth_identities" USING btree ("provider","provider_subject");--> statement-breakpoint
CREATE INDEX "auth_identities_user_idx" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delegated_signers_turnkey_user_uq" ON "delegated_signers" USING btree ("turnkey_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delegated_signers_user_active_uq" ON "delegated_signers" USING btree ("user_id") WHERE "delegated_signers"."status" <> 'revoked';--> statement-breakpoint
CREATE UNIQUE INDEX "executed_transactions_network_hash_uq" ON "executed_transactions" USING btree ("network","tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "executed_transactions_request_uq" ON "executed_transactions" USING btree ("transaction_request_id");--> statement-breakpoint
CREATE INDEX "executed_transactions_status_idx" ON "executed_transactions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_devices_token_uq" ON "notification_devices" USING btree ("expo_push_token");--> statement-breakpoint
CREATE INDEX "notification_devices_user_idx" ON "notification_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_user_idx" ON "oauth_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_agent_idx" ON "oauth_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_refresh_token_hash_uq" ON "sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spending_ledger_request_uq" ON "spending_ledger" USING btree ("transaction_request_id");--> statement-breakpoint
CREATE INDEX "spending_ledger_agent_time_idx" ON "spending_ledger" USING btree ("agent_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "spending_reservations_request_uq" ON "spending_reservations" USING btree ("transaction_request_id");--> statement-breakpoint
CREATE INDEX "spending_reservations_agent_status_idx" ON "spending_reservations" USING btree ("agent_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "token_records_hash_uq" ON "token_records" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "token_records_grant_idx" ON "token_records" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_requests_user_idempotency_uq" ON "transaction_requests" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "transaction_requests_state_expires_idx" ON "transaction_requests" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "transaction_requests_agent_created_idx" ON "transaction_requests" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "transaction_requests_wallet_created_idx" ON "transaction_requests" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE INDEX "transaction_requests_payload_hash_idx" ON "transaction_requests" USING btree ("payload_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "users_turnkey_sub_org_uq" ON "users" USING btree ("turnkey_sub_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_addresses_family_address_uq" ON "wallet_addresses" USING btree ("family","address");--> statement-breakpoint
CREATE INDEX "wallet_addresses_wallet_idx" ON "wallet_addresses" USING btree ("wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_turnkey_wallet_uq" ON "wallets" USING btree ("turnkey_wallet_id");--> statement-breakpoint
CREATE INDEX "wallets_user_idx" ON "wallets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_uq" ON "webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("received_at") WHERE "webhook_events"."processed_at" IS NULL;