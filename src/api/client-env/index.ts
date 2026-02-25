// src/api/client-env/index.ts

/**
 * Client Environment API Routes
 *
 * POST   /client-env/setup   — Manual setup (for UI)
 * DELETE /client-env          — Remove environment
 * GET    /client-env/status   — Environment status
 */

import type { Context } from "hono";
import type { Env } from "../types/worker";
import { requireOwner } from "../lib/auth";
import { listKeys, getDecryptedKey } from "../integrations/keys/storage";
import { setupClientEnvironment } from "./setup";
import { teardownClientEnvironment } from "./teardown";
import { getClientEnvStatus } from "./status";

// ============================================================
// POST /client-env/setup
// ============================================================

export async function handleSetupClientEnv(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const accountId = auth.account_id;

  // Get CF key
  const cfKeys = await listKeys(env, accountId, "cloudflare");
  const activeCfKey = cfKeys.find((k) => k.status === "active");

  if (!activeCfKey) {
    return c.json({
      ok: false,
      error: "cloudflare_integration_required",
      message: "Add Cloudflare integration first via POST /integrations/cloudflare/init",
    }, 400);
  }

  // Check if already set up
  const row = await env.DB301.prepare(
    "SELECT client_env FROM account_keys WHERE id = ?"
  ).bind(activeCfKey.id).first<{ client_env: string | null }>();

  if (row?.client_env) {
    try {
      const existing = JSON.parse(row.client_env);
      if (existing.ready) {
        return c.json({
          ok: true,
          status: "already_ready",
          client_env: existing,
        });
      }
    } catch {
      // Invalid — proceed with setup
    }
  }

  // Decrypt CF token
  const decrypted = await getDecryptedKey(env, activeCfKey.id);
  if (!decrypted) {
    return c.json({ ok: false, error: "cf_key_decrypt_failed" }, 500);
  }

  const cfToken = decrypted.secrets.token;
  const cfAccountId = activeCfKey.external_account_id!;

  // Get VT key (optional)
  let vtApiKey: string | undefined;
  const vtKeys = await listKeys(env, accountId, "virustotal");
  const activeVtKey = vtKeys.find((k) => k.status === "active");
  if (activeVtKey) {
    try {
      const vtDecrypted = await getDecryptedKey(env, activeVtKey.id);
      if (vtDecrypted) {
        vtApiKey = vtDecrypted.secrets.apiKey;
      }
    } catch {
      // VT optional
    }
  }

  // Run setup
  const result = await setupClientEnvironment({
    cfAccountId,
    cfToken,
    accountId,
    env,
    vtApiKey,
  });

  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, 500);
  }

  // Save client_env
  if (result.client_env) {
    await env.DB301.prepare(
      "UPDATE account_keys SET client_env = ? WHERE id = ?"
    ).bind(JSON.stringify(result.client_env), activeCfKey.id).run();
  }

  return c.json({
    ok: true,
    client_env: result.client_env,
    initial_sync: result.initial_sync,
  });
}

// ============================================================
// DELETE /client-env
// ============================================================

export async function handleDeleteClientEnv(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const result = await teardownClientEnvironment(env, auth.account_id);

  if (!result.ok) {
    return c.json({
      ok: false,
      error: result.error,
      deleted: result.deleted,
      errors: result.errors,
    }, 500);
  }

  return c.json({
    ok: true,
    deleted: result.deleted,
  });
}

// ============================================================
// GET /client-env/status
// ============================================================

export async function handleGetClientEnvStatus(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const live = c.req.query("live") === "true";
  const result = await getClientEnvStatus(env, auth.account_id, live);

  return c.json(result);
}
