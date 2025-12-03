// src/api/integrations/keys/router.ts

//HTTP: GET/DELETE /integrations/keys

import { Hono } from "hono";
import { createKey, updateKey, deleteKey, listKeys, getKey } from "../../integrations";

const router = new Hono();

// GET /integrations/keys?account_id=1
router.get("/", async (c) => {
  const accountId = Number(c.req.query("account_id"));
  const env = c.env;

  const rows = await listKeys(env, accountId);
  return c.json({ ok: true, keys: rows });
});

// GET /integrations/keys/:id
router.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const env = c.env;

  const row = await getKey(env, id);
  return c.json({ ok: true, key: row });
});

// POST /integrations/keys
router.post("/", async (c) => {
  const env = c.env;
  const body = await c.req.json();

  await createKey(env, body);
  return c.json({ ok: true });
});

// PATCH /integrations/keys/:id
router.patch("/:id", async (c) => {
  const env = c.env;
  const id = Number(c.req.param("id"));
  const body = await c.req.json();

  await updateKey(env, { key_id: id, ...body });
  return c.json({ ok: true });
});

// DELETE /integrations/keys/:id
router.delete("/:id", async (c) => {
  const env = c.env;
  const id = Number(c.req.param("id"));

  await deleteKey(env, id);
  return c.json({ ok: true });
});

export default router;

