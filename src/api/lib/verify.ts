// src/api/lib/verify.ts

/**
 * Универсальная библиотечная проверка OmniAuth.
 * НЕ endpoint.
 * Вызывается из /auth/verify.
 */

// src/api/lib/verify.ts
// Универсальная библиотека завершения OmniFlow
// Используется в endpoint /auth/verify

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getDB } from "../lib/d1";
import { verifyOmniToken } from "../lib/omni_tokens";
import { logAuth } from "../lib/logger";
import { signJWT } from "../lib/jwt";
import { createRefreshSession } from "../lib/session";
import { extractRequestInfo } from "../lib/fingerprint";  // ДОБАВЛЕНО #4

const app = new Hono();

app.get("/", async (c) => {
  const env = c.env;
  const db = getDB(env);

  const token = c.req.query("token");
  const code = c.req.query("code") || null;

  // ИСПРАВЛЕНИЕ #4: Извлечение IP и UA для fingerprinting
  const { ip, ua } = extractRequestInfo(c);

  if (!token) {
    throw new HTTPException(400, { message: "token_required" });
  }

  // 1. Проверяем omni-token
  const session = await verifyOmniToken(env, token, code);
  if (!session) {
    throw new HTTPException(400, { message: "invalid_or_expired_token" });
  }

  const { identifier, type } = session;

  if (!identifier) {
    throw new HTTPException(400, { message: "identifier_missing" });
  }

  // 2. Проверяем/создаём пользователя
  let user = await db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(identifier)
    .first();

  if (!user) {
    const res = await db
      .prepare(
        `INSERT INTO users (email, user_type, created_at, updated_at)
         VALUES (?, 'client', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .bind(identifier)
      .run();

    user = {
      id: res.lastInsertRowId,
      email: identifier,
      user_type: "client",
    };
  }

  const userId = user.id;
  let accountId: number | null = null;
  let accountRole: "owner" | "editor" | "viewer" | "none" = "none";

  // 3. Создание аккаунта (register) или выбор (reset/login)
  if (type === "register") {
    const acc = await db
      .prepare(
        `INSERT INTO accounts (owner_user_id, created_at, updated_at)
         VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .bind(userId)
      .run();

    accountId = acc.lastInsertRowId;

    await db
      .prepare(
        `INSERT INTO account_members (account_id, user_id, role)
         VALUES (?, ?, 'owner')`
      )
      .bind(accountId, userId)
      .run();

    accountRole = "owner";
  } else {
    const am = await db
      .prepare(
        `SELECT account_id, role FROM account_members
         WHERE user_id = ?
         ORDER BY account_id ASC LIMIT 1`
      )
      .bind(userId)
      .first();

    if (!am) throw new HTTPException(403, { message: "no_account" });

    accountId = am.account_id;
    accountRole = am.role;
  }

  // 4. Создаём session
  const sess = await db
    .prepare(
      `INSERT INTO sessions (user_id, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
    )
    .bind(userId, ip, ua)
    .run();

  const sessionId = sess.lastInsertRowId;

  //  5. ИСПРАВЛЕНО #2: передаём account_id и user_type в createRefreshSession
  await createRefreshSession(c, env, userId, accountId, user.user_type || 'client');

  // 6. ИСПРАВЛЕНИЕ #4: Создаём access_token с fingerprint
  const accessToken = await signJWT(
    {
      typ: "access",
      user_id: userId,
      account_id: accountId,
      session_id: sessionId,
      iat: Math.floor(Date.now() / 1000),
    },
    env,
    "15m",
    { ip, ua }  // ✅ Fingerprint
  );

  // 7. Загружаем аккаунты
  const accounts = await db
    .prepare(
      `SELECT
         am.account_id AS id,
         am.role,
         am.status,
         a.owner_user_id
       FROM account_members am
       JOIN accounts a ON am.account_id = a.id
       WHERE am.user_id = ?
       ORDER BY am.account_id ASC`
    )
    .bind(userId)
    .all();

  //  8. Логирование
  await logAuth(
    env,
    type === "reset" ? "login" : (type as "register" | "login" | "logout" | "refresh"),
    userId,
    accountId,
    ip,
    ua,
    user.user_type,
    accountRole
  );

  // 9. Ответ
  return c.json({
    ok: true,
    user,
    accounts: accounts.results ?? accounts,
    active_account_id: accountId,
    access_token: accessToken,
    expires_in: 900,
  });
});

export default app;

