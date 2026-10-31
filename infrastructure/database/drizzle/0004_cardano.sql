ALTER TYPE "public"."chain_family" ADD VALUE 'cardano';--> statement-breakpoint
ALTER TYPE "public"."network" ADD VALUE 'cardano-mainnet';--> statement-breakpoint
ALTER TYPE "public"."network" ADD VALUE 'cardano-preprod';--> statement-breakpoint
ALTER TABLE "wallet_addresses" ADD COLUMN "public_key" text;