// src/api/auth/me.ts
/**
 * GET /auth/me
 * Проверка текущего пользователя по JWT access token.
 * - Rate limiting (authGuard)
 * - Проверка JWT через verifyJWT()
 * - Получение пользователя из D1
 * - Аудит (event_type = 'auth_check')
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getDB } from "../lib/d1";
import { verifyAccessToken } from "../lib/jwt";  

const app = new Hono();

app.get("/", async (c) => {
  const env = c.env;
  const db = getDB(env);

  // 1. Проверка access_token
  const auth = await verifyAccessToken(env, c.req);
  if (!auth) {
    throw new HTTPException(401, { message: "unauthorized" });
  }

  const userId = auth.user_id;
  let activeAccountId = auth.account_id || null;

  // 2. Загружаем пользователя
  const user = await db
    .prepare(`
      SELECT
        id,
        email,
        phone,
        tg_id,
        name,
        user_type,
        created_at,
        updated_at
      FROM users
      WHERE id = ?
    `)
    .bind(userId)
    .first();

  if (!user) {
    throw new HTTPException(404, { message: "user_not_found" });
  }

  // 3. Загружаем аккаунты пользователя
  const acc = await db
    .prepare(`
      SELECT
        am.account_id AS id,
        am.role,
        am.status,
        a.owner_user_id
      FROM account_members am
      JOIN accounts a ON am.account_id = a.id
      WHERE am.user_id = ?
      ORDER BY am.account_id ASC
    `)
    .bind(userId)
    .all();

  const accounts = acc.results ?? acc;

  if (accounts.length === 0) {
    throw new HTTPException(403, { message: "no_accounts" });
  }

  // 4. Определяем active_account_id
  if (!activeAccountId) {
    // сначала ищем где user = owner
    const ownerAcc = accounts.find(a => a.role === "owner");
    activeAccountId = ownerAcc?.id || accounts[0].id;
  }

  // 5. Финальный ответ
  return c.json({
    ok: true,
    user,
    accounts,
    active_account_id: activeAccountId,
  });
});

export default app;

