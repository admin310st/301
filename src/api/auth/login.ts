// src/api/auth/login.ts

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getDB } from "../lib/d1";
import { signJWT } from "../lib/jwt";
import { logAuth } from "../lib/logger";
import { verifyPassword } from "../lib/crypto";
import { createRefreshSession } from "../lib/session";
import { extractRequestInfo } from "../lib/fingerprint";  // ДОБАВЛЕНО #4

const app = new Hono();

app.post("/", async (c) => {
  const env = c.env;
  const db = getDB(env);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid_json" });
  }

  const email = body.email || null;
  const phone = body.phone || null;
  const password = body.password || null;
  const tg_init = body.tg_init || null; // Telegram WebApp initData

  // ИСПРАВЛЕНИЕ #4: Извлечение IP и UA для fingerprinting
  const { ip, ua } = extractRequestInfo(c);

  // 1. TELEGRAM MINI-APP (авто-логин через initData)
  if (tg_init) {
    const tg_id = tg_init.user?.id;

    if (!tg_id) {
      throw new HTTPException(400, { message: "invalid_telegram_data" });
    }

    const user = await db
      .prepare("SELECT * FROM users WHERE tg_id = ? LIMIT 1")
      .bind(tg_id)
      .first();

    if (!user) {
      throw new HTTPException(404, { message: "user_not_found" });
    }

    const member = await db
      .prepare(
        `SELECT account_id, role FROM account_members
         WHERE user_id = ?
         ORDER BY account_id ASC LIMIT 1`
      )
      .bind(user.id)
      .first();

    if (!member) throw new HTTPException(403, { message: "no_account" });

    // ИСПРАВЛЕНО #2: передаём account_id и user_type
    await createRefreshSession(c, env, user.id, member.account_id, user.user_type);

    // ИСПРАВЛЕНИЕ #4: access_token с fingerprint
    const accessToken = await signJWT(
      {
        typ: "access",
        user_id: user.id,
        account_id: member.account_id,
        iat: Math.floor(Date.now() / 1000),
      },
      env,
      "15m",
      { ip, ua }  // ✅ Fingerprint
    );

    // логирование
    await logAuth(
      env,
      "login",
      user.id,
      member.account_id,
      ip,
      ua,
      user.user_type,
      member.role
    );

    return c.json({
      ok: true,
      access_token: accessToken,
      expires_in: 900,
      active_account_id: member.account_id,
    });
  }

  // 2. EMAIL / PHONE + PASSWORD LOGIN

  if ((!email && !phone) || !password) {
    throw new HTTPException(400, { message: "missing_credentials" });
  }

  const user = await db
    .prepare(
      `SELECT * FROM users
         WHERE email = ? OR phone = ?
         LIMIT 1`
    )
    .bind(email, phone)
    .first();

  if (!user) {
    throw new HTTPException(401, { message: "invalid_login" });
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    throw new HTTPException(401, { message: "invalid_login" });
  }

  const member = await db
    .prepare(
      `SELECT account_id, role FROM account_members
       WHERE user_id = ?
       ORDER BY account_id ASC LIMIT 1`
    )
    .bind(user.id)
    .first();

  if (!member) {
    throw new HTTPException(403, { message: "no_account" });
  }

  // ИСПРАВЛЕНО #2: передаём account_id и user_type
  await createRefreshSession(c, env, user.id, member.account_id, user.user_type);

  // ИСПРАВЛЕНИЕ #4: access_token с fingerprint
  const accessToken = await signJWT(
    {
      typ: "access",
      user_id: user.id,
      account_id: member.account_id,
      iat: Math.floor(Date.now() / 1000),
    },
    env,
    "15m",
    { ip, ua }  // ✅ Fingerprint
  );

  // логирование
  await logAuth(
    env,
    "login",
    user.id,
    member.account_id,
    ip,
    ua,
    user.user_type,
    member.role
  );

  return c.json({
    ok: true,
    access_token: accessToken,
    expires_in: 900,
    active_account_id: member.account_id,
  });
});

export default app;

