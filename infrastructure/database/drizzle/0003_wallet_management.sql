CREATE TABLE "watch_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"family" "chain_family" NOT NULL,
	"network" "network" NOT NULL,
	"address" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "watch_wallets" ADD CONSTRAINT "watch_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watch_wallets_user_family_address_uq" ON "watch_wallets" USING btree ("user_id","family","address") WHERE "watch_wallets"."removed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "watch_wallets_user_idempotency_uq" ON "watch_wallets" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "watch_wallets_user_idx" ON "watch_wallets" USING btree ("user_id","created_at");