/*
 * Typed binding of contracts to handlers. A handler's input types are inferred from the
 * contract's Zod schemas and its return type must satisfy the contract's response schema
 * (compile time), which is also enforced at run time before anything is sent. The
 * handler maps in app.ts are keyed by contract name, so a contract added to `api` without
 * a handler (or a handler whose output drifts) is a type error.
 */
import type { EndpointContract } from "@zyropay/shared";
import { findSecretMaterial, IdempotencyKeySchema } from "@zyropay/shared";
import type { Context, Hono } from "hono";
import type { z } from "zod";
import type { Ctx } from "../deps";
import { AppError } from "../lib/errors";
import { enforceRateLimit } from "../services/rate-limit";
import type { UserPrincipal } from "../services/sessions";
import type { AppEnv } from "./context";
import { requireInternal, requireUser } from "./auth";

type In<C, K extends "params" | "query" | "body"> = C extends {
  readonly [P in K]: infer S extends z.ZodType;
}
  ? z.infer<S>
  : undefined;
export type Out<C> = C extends { readonly response: infer S extends z.ZodType }
  ? z.input<S>
  : never;

export interface HandlerArgs<C extends EndpointContract> {
  readonly params: In<C, "params">;
  readonly query: In<C, "query">;
  readonly body: In<C, "body">;
  readonly ctx: Ctx;
  readonly c: Context<AppEnv>;
  /** Present for `auth: "user"` endpoints. */
  readonly principal: C["auth"] extends "user" ? UserPrincipal : null;
  /** Raw request body (webhooks verify signatures over it). */
  readonly rawBody: string;
}

export type Handler<C extends EndpointContract> = (args: HandlerArgs<C>) => Promise<Out<C>>;

const MAX_BODY_BYTES = 256 * 1024;

function idempotencyKeyFromBody(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const b = body as { idempotencyKey?: unknown; input?: { idempotencyKey?: unknown } };
  const key = b.idempotencyKey ?? b.input?.idempotencyKey;
  return typeof key === "string" ? key : undefined;
}

export function bind<C extends EndpointContract>(
  app: Hono<AppEnv>,
  contract: C,
  handler: Handler<C>,
): void {
  app.on(contract.method, contract.path, async (c) => {
    const ctx = c.get("ctx");
    const rules = ctx.deps.config.rateLimits;
    let principal: UserPrincipal | null = null;
    switch (contract.auth) {
      case "user":
        principal = await requireUser(c, ctx);
        await enforceRateLimit(ctx, "user", principal.userId, rules.user);
        break;
      case "internal":
        requireInternal(c, ctx);
        await enforceRateLimit(ctx, "internal", c.req.param("agentId") ?? "mcp", rules.internal);
        break;
      case "webhook":
        await enforceRateLimit(ctx, "webhook", ctx.ip ?? "unknown", rules.webhook);
        break;
      case "none":
        await enforceRateLimit(ctx, "auth", ctx.ip ?? "unknown", rules.auth);
        break;
    }

    const params = contract.params === undefined ? undefined : contract.params.parse(c.req.param());
    const query = contract.query === undefined ? undefined : contract.query.parse(c.req.query());

    let rawBody = "";
    if (contract.method !== "GET" && contract.method !== "DELETE") {
      const declared = Number(c.req.header("content-length") ?? "0");
      if (declared > MAX_BODY_BYTES) throw new AppError("BAD_REQUEST", "request body too large");
      rawBody = await c.req.text();
      if (rawBody.length > MAX_BODY_BYTES)
        throw new AppError("BAD_REQUEST", "request body too large");
    }
    let body: unknown = undefined;
    if (contract.body !== undefined && contract.auth !== "webhook") {
      let json: unknown;
      try {
        json = rawBody === "" ? {} : JSON.parse(rawBody);
      } catch {
        throw new AppError("BAD_REQUEST", "body must be JSON");
      }
      // ADR-003: ZyroPay never receives a recovery phrase or private key (they go from the
      // device to Turnkey's import enclave only). Refuse anything that looks like one before
      // it is parsed, stored or logged. Only the reason is logged (not the path: a key name
      // could itself be attacker-chosen text), never the value.
      const secret = findSecretMaterial(json);
      if (secret !== null) {
        ctx.deps.logger.warn("request.secret_material_refused", {
          path: contract.path,
          reason: secret.reason,
        });
        throw new AppError(
          "BAD_REQUEST",
          "ZyroPay never accepts recovery phrases or private keys. Nothing was stored.",
        );
      }
      body = contract.body.parse(json);
    }

    if (contract.idempotent === true) {
      const header = c.req.header("idempotency-key");
      const parsed = IdempotencyKeySchema.safeParse(header);
      if (!parsed.success)
        throw new AppError("BAD_REQUEST", "a valid Idempotency-Key header is required");
      const inBody = idempotencyKeyFromBody(body);
      if (inBody !== undefined && inBody !== parsed.data) {
        throw new AppError("BAD_REQUEST", "Idempotency-Key header does not match the body");
      }
    }

    const result = await handler({
      params: params as In<C, "params">,
      query: query as In<C, "query">,
      body: body as In<C, "body">,
      ctx,
      c,
      principal: principal as HandlerArgs<C>["principal"],
      rawBody,
    });
    const checked = contract.response.safeParse(result);
    if (!checked.success) {
      ctx.deps.logger.error("response.contract_violation", {
        path: contract.path,
        issues: checked.error.issues
          .slice(0, 5)
          .map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      throw new Error("response contract violation");
    }
    return c.json(checked.data as object, 200);
  });
}
