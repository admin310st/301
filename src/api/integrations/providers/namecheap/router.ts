// src/api/integrations/providers/namecheap/router.ts

import { Hono } from "hono";
import { handleInitKeyNamecheap } from "./initkey";
import { namecheapListDomains, namecheapSetNs, getRelayIps } from "./namecheap";
import type { NamecheapSecrets } from "./namecheap";
import { requireOwner } from "../../../lib/auth";
import { getDecryptedKey, verifyKeyOwnership } from "../../keys/storage";
import type { Env } from "../../../types/worker";

const router = new Hono<{ Bindings: Env }>();

// POST /integrations/namecheap/init
router.post("/init", handleInitKeyNamecheap);

// GET /integrations/namecheap/proxy-ips
// Возвращает список IP для whitelist в Namecheap
router.get("/proxy-ips", async (c) => {
  const env = c.env;

  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const ips = await getRelayIps(env);
  return c.json({ ok: true, ips });
});

// GET /integrations/namecheap/domains?key_id=123
router.get("/domains", async (c) => {
  const env = c.env;

  // Auth
  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const keyId = Number(c.req.query("key_id"));
  if (!keyId || isNaN(keyId)) {
    return c.json({ ok: false, error: "key_id_required" }, 400);
  }

  // Verify ownership
  const isOwner = await verifyKeyOwnership(env, keyId, auth.account_id);
  if (!isOwner) {
    return c.json({ ok: false, error: "key_not_found" }, 404);
  }

  // Decrypt key via storage.ts
  let secrets: NamecheapSecrets;
  try {
    const decrypted = await getDecryptedKey(env, keyId);
    if (!decrypted) {
      return c.json({ ok: false, error: "key_not_found" }, 404);
    }
    secrets = decrypted.secrets as NamecheapSecrets;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: message }, 400);
  }

  const result = await namecheapListDomains(env, secrets);

  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, 500);
  }

  return c.json({ ok: true, domains: result.domains });
});

// POST /integrations/namecheap/set-ns
// Body: { key_id: number, domain: string, nameservers: string[] }
router.post("/set-ns", async (c) => {
  const env = c.env;

  // Auth
  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  let body: { key_id: number; domain: string; nameservers: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { key_id, domain, nameservers } = body;

  if (!key_id || typeof key_id !== "number") {
    return c.json({ ok: false, error: "key_id_required" }, 400);
  }

  if (!domain || typeof domain !== "string") {
    return c.json({ ok: false, error: "domain_required" }, 400);
  }

  if (!Array.isArray(nameservers) || nameservers.length === 0) {
    return c.json({ ok: false, error: "nameservers_required" }, 400);
  }

  // Verify ownership
  const isOwner = await verifyKeyOwnership(env, key_id, auth.account_id);
  if (!isOwner) {
    return c.json({ ok: false, error: "key_not_found" }, 404);
  }

  // Decrypt key via storage.ts
  let secrets: NamecheapSecrets;
  try {
    const decrypted = await getDecryptedKey(env, key_id);
    if (!decrypted) {
      return c.json({ ok: false, error: "key_not_found" }, 404);
    }
    secrets = decrypted.secrets as NamecheapSecrets;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: message }, 400);
  }

  const result = await namecheapSetNs(env, secrets, domain, nameservers);

  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, 400);
  }

  return c.json({ ok: true, message: "nameservers_updated" });
});

export default router;
