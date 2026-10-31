import type { PluginAdapter, PluginManifest } from "@zyropay/shared";
import { getPluginManifest, PLUGIN_REGISTRY } from "@zyropay/shared";
import { and, eq } from "drizzle-orm";
import * as t from "../db/tables";
import type { Ctx } from "../deps";
import { AppError } from "../lib/errors";
import { audit } from "./audit";

/** A plugin is "configured" when the deployment wired an adapter for it. */
function isConfigured(ctx: Ctx, manifest: PluginManifest): boolean {
  return manifest.status === "available" && ctx.deps.plugins[manifest.id] !== undefined;
}

export async function listPlugins(ctx: Ctx, userId: string) {
  const settings = await ctx.deps.db
    .select()
    .from(t.userPluginSettings)
    .where(eq(t.userPluginSettings.userId, userId));
  return PLUGIN_REGISTRY.map((manifest) => ({
    manifest,
    enabled: settings.some((s) => s.pluginId === manifest.id && s.enabled),
    configured: isConfigured(ctx, manifest),
  }));
}

export async function setPluginEnabled(
  ctx: Ctx,
  userId: string,
  pluginId: string,
  enabled: boolean,
) {
  const manifest = getPluginManifest(pluginId);
  if (manifest === undefined) throw new AppError("NOT_FOUND", "plugin not found");
  if (enabled && !isConfigured(ctx, manifest)) {
    throw new AppError("PLUGIN_DISABLED", "plugin is not available in this deployment");
  }
  const now = ctx.deps.clock.now();
  await ctx.deps.db.transaction(async (tx) => {
    // The registry is code; mirror it into `plugins` for the FK (idempotent).
    await tx
      .insert(t.plugins)
      .values({
        id: manifest.id,
        name: manifest.name,
        status: manifest.status,
        riskCategory: manifest.riskCategory,
        manifest,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: t.plugins.id,
        set: {
          name: manifest.name,
          status: manifest.status,
          riskCategory: manifest.riskCategory,
          manifest,
          updatedAt: now,
        },
      });
    await tx
      .insert(t.userPluginSettings)
      .values({ userId, pluginId, enabled, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [t.userPluginSettings.userId, t.userPluginSettings.pluginId],
        set: { enabled, updatedAt: now },
      });
  });
  await audit(ctx, {
    actorType: "user",
    actorId: userId,
    userId,
    action: enabled ? "plugin.enabled" : "plugin.disabled",
    targetType: "plugin",
    targetId: pluginId,
  });
  return { pluginId, enabled };
}

/** The adapter for a plugin the user has enabled; PLUGIN_DISABLED otherwise. */
export async function requireEnabledPlugin(
  ctx: Ctx,
  userId: string,
  pluginId: string,
): Promise<PluginAdapter> {
  const manifest = getPluginManifest(pluginId);
  const adapter = ctx.deps.plugins[pluginId];
  if (manifest === undefined || adapter === undefined || !isConfigured(ctx, manifest)) {
    throw new AppError("PLUGIN_DISABLED", `${pluginId} is not available`);
  }
  const [setting] = await ctx.deps.db
    .select()
    .from(t.userPluginSettings)
    .where(
      and(eq(t.userPluginSettings.userId, userId), eq(t.userPluginSettings.pluginId, pluginId)),
    );
  if (setting?.enabled !== true)
    throw new AppError("PLUGIN_DISABLED", `${pluginId} is disabled for this user`);
  return adapter;
}
