import { Hono } from "hono";
import { z } from "zod";
import { encrypt, decrypt } from "../../lib/crypto";
import { ALLOWLIST, getProviderModule } from "../providers/registry";

export const keysRouter = new Hono<{ Bindings: Env }>();

type Env = {
  DB301: D1Database;
  KV_CREDENTIALS: KVNamespace;
  MASTER_SECRET: string;
};

const KeySchema = z.object({
  account_id: z.string().min(1),
  provider: z.enum(ALLOWLIST),
  credentials: z.record(z.string()).optional(),
  // опционально: key_alias, provider_scope, expires_at
});

const mask = (s: string) => (s.length <= 2 ? "***" : s.slice(0, 2) + "***");

// CREATE / UPDATE
keysRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = KeySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.format() }, 400);

  const { account_id, provider, credentials } = parsed.data;

  // 1) шифруем и кладём в KV
  const kvKey = `${account_id}:${provider}`;
  const enc = await encrypt(credentials || {}, c.env.MASTER_SECRET);
  await c.env.KV_CREDENTIALS.put(kvKey, JSON.stringify(enc));

  // 2) фиксируем метаданные в D1 (минимум обязательных полей)
  await c.env.DB301
    .prepare(
      `INSERT OR REPLACE INTO account_keys (account_id, provider, kv_key, status)
       VALUES (?, ?, ?, 'active')`
    )
    .bind(account_id, provider, kvKey)
    .run();

  return c.json({ ok: true });
});

// LIST
keysRouter.get("/", async (c) => {
  const accountId = c.req.query("account_id");
  if (!accountId) return c.json({ error: "Missing account_id" }, 400);

  const { results } = await c.env.DB301
    .prepare(
      `SELECT id, provider, status, last_used, expires_at, created_at
         FROM account_keys
        WHERE account_id = ?
        ORDER BY provider`
    )
    .bind(accountId)
    .all();

  return c.json(results);
});

// ---- GET one (masked view) ----
keysRouter.get("/:provider", async (c) => {
  const accountId = c.req.query("account_id");
  const provider = c.req.param("provider");
  if (!accountId || !provider)
    return c.json({ error: "Missing params" }, 400);

  const raw = await c.env.KV_CREDENTIALS.get(
    `${accountId}:${provider}`,
    "json"
  );
  if (!raw) return c.json({ error: "Not found" }, 404);

  try {
    const creds = await decrypt<Record<string, string>>(
      raw,
      c.env.MASTER_SECRET
    );

    const masked = Object.fromEntries(
      Object.entries(creds).map(([k, v]) => [
        k,
        v.length <= 2 ? "***" : v.slice(0, 2) + "***",
      ])
    );

    return c.json(masked);
  } catch (err) {
    console.error("Decryption error:", err);
    return c.json({ error: "Invalid or corrupted key data" }, 400);
  }
});

// DELETE
keysRouter.delete("/:provider", async (c) => {
  const accountId = c.req.query("account_id");
  const provider = c.req.param("provider");
  if (!accountId || !provider) return c.json({ error: "Missing params" }, 400);

  const kvKey = `${accountId}:${provider}`;
  await c.env.KV_CREDENTIALS.delete(kvKey);

  await c.env.DB301
    .prepare(`DELETE FROM account_keys WHERE account_id = ? AND provider = ?`)
    .bind(accountId, provider)
    .run();

  return c.json({ ok: true });
});

// TEST (обновляет last_used при успехе)
keysRouter.post("/:provider/test", async (c) => {
  const accountId = c.req.query("account_id");
  const provider = c.req.param("provider");
  if (!accountId || !provider) return c.json({ error: "Missing params" }, 400);

  const data = await c.env.KV_CREDENTIALS.get(`${accountId}:${provider}`, "json");
  if (!data) return c.json({ error: "No credentials" }, 404);

  const creds = await decrypt<Record<string, string>>(data, c.env.MASTER_SECRET);
  const module = await getProviderModule(provider as any);
  const result = await module.test?.(accountId, async () => creds);

  if (result?.ok) {
    await c.env.DB301
      .prepare(`UPDATE account_keys SET last_used = CURRENT_TIMESTAMP WHERE account_id = ? AND provider = ?`)
      .bind(accountId, provider)
      .run();
  }

  return c.json({ ok: true, result });
});

export default keysRouter;

