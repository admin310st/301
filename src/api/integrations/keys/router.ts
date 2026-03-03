// src/api/integrations/keys/router.ts

//HTTP: GET/DELETE /integrations/keys

import { Hono } from "hono";
import { requireOwner } from "../../lib/auth";
import { createKey, updateKey, deleteKey, listKeys, getKey, getDecryptedKey } from "../../integrations";
import { deleteWorkerSecret } from "../providers/cloudflare/workers";
import type { Env } from "../../types/worker";

const router = new Hono<{ Bindings: Env }>();

// GET /integrations/keys
router.get("/", async (c) => {
  const env = c.env;

  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const rows = await listKeys(env, auth.account_id);
  return c.json({ ok: true, keys: rows });
});

// GET /integrations/keys/:id
router.get("/:id", async (c) => {
  const env = c.env;
  const id = Number(c.req.param("id"));

  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const row = await getKey(env, id);
  if (!row || row.account_id !== auth.account_id) {
    return c.json({ ok: false, error: "not_found" }, 404);
  }

  return c.json({ ok: true, key: row });
});

// POST /integrations/keys
router.post("/", async (c) => {
  const env = c.env;

  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const body = await c.req.json();
  const result = await createKey(env, { ...body, account_id: auth.account_id });
  return c.json(result);
});

// PATCH /integrations/keys/:id
router.patch("/:id", async (c) => {
  const env = c.env;
  const id = Number(c.req.param("id"));

  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const record = await getKey(env, id);
  if (!record || record.account_id !== auth.account_id) {
    return c.json({ ok: false, error: "not_found" }, 404);
  }

  const body = await c.req.json();
  const result = await updateKey(env, { key_id: id, ...body });
  return c.json(result);
});

// DELETE /integrations/keys/:id
router.delete("/:id", async (c) => {
  const env = c.env;
  const id = Number(c.req.param("id"));

  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const record = await getKey(env, id);
  if (!record || record.account_id !== auth.account_id) {
    return c.json({ ok: false, error: "not_found" }, 404);
  }

  // VT cleanup: delete VT_API_KEY from client worker (best-effort)
  if (record.provider === "virustotal") {
    try {
      const cfKey = await env.DB301.prepare(
        `SELECT id, client_env, external_account_id FROM account_keys
         WHERE account_id = ? AND provider = 'cloudflare' AND status = 'active' AND client_env IS NOT NULL`
      ).bind(auth.account_id).first<{ id: number; client_env: string; external_account_id: string }>();

      if (cfKey) {
        const clientEnv = JSON.parse(cfKey.client_env) as { health_worker?: boolean; ready?: boolean };
        if (clientEnv.ready && clientEnv.health_worker) {
          const cfDecrypted = await getDecryptedKey(env, cfKey.id);
          if (cfDecrypted) {
            const cfToken = cfDecrypted.secrets.token || cfDecrypted.secrets.apiToken;
            if (cfToken) {
              const cleanup = await deleteWorkerSecret(
                cfKey.external_account_id,
                "301-health",
                "VT_API_KEY",
                cfToken
              );
              if (!cleanup.ok) {
                console.warn("VT secret cleanup failed:", cleanup.error);
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn("VT secret cleanup error (best-effort):", e);
    }
  }

  const result = await deleteKey(env, id);
  return c.json(result);
});

export default router;
