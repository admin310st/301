// src/api/auth/refresh.ts
/**
 * Обновление access-токена по refresh_id (из cookie).
 * Использует rateLimit, KV, JWT и audit_log.
 * ИСПРАВЛЕНИЕ #4: Добавлен fingerprinting при создании нового токена
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logAuth } from "../lib/logger";
import { signJWT } from "../lib/jwt";
import { extractRequestInfo } from "../lib/fingerprint";

const app = new Hono();

app.post("/", async (c) => {
  const env = c.env;

  // ИСПРАВЛЕНИЕ #4: Извлечение IP и UA для fingerprinting
  const { ip, ua } = extractRequestInfo(c);

  // 1. Получаем refresh_id из Cookie
  const cookieHeader = c.req.header("Cookie") || "";
  const oldRefresh = cookieHeader
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith("refresh_id="))
    ?.split("=")[1];

  if (!oldRefresh) {
    throw new HTTPException(401, { message: "missing_refresh_id" });
  }

  // 2. Проверяем refresh в KV
  const session = await env.KV_SESSIONS.get(`refresh:${oldRefresh}`, {
    type: "json",
  });

  if (!session || !session.user_id) {
    throw new HTTPException(401, { message: "invalid_refresh" });
  }

  const user_id = session.user_id;
  const account_id = session.account_id ?? null;
  const user_type = session.user_type ?? "client";

  // 3. ИСПРАВЛЕНИЕ #4: Генерируем новый access token с fingerprint
  const access_token = await signJWT(
    {
      user_id,
      account_id,
      user_type,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900, // 15 минут
    },
    env,
    "15m",
    { ip, ua }  // ✅ Fingerprint
  );

  // 4. Генерируем новый refresh_id
  const new_refresh_id = crypto.randomUUID();

  // 5. Записываем новый refresh в KV
  await env.KV_SESSIONS.put(
    `refresh:${new_refresh_id}`,
    JSON.stringify({ user_id, account_id, user_type }),
    { expirationTtl: 60 * 60 * 24 * 7 } // 7 дней
  );

  // 6. Удаляем старый refresh
  await env.KV_SESSIONS.delete(`refresh:${oldRefresh}`);

  // 7. Ставим новую Cookie
  c.header(
    "Set-Cookie",
    `refresh_id=${new_refresh_id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`
  );

  // 8. Логируем событие
  await logAuth(env, "refresh", user_id, account_id, ip, ua, user_type);

  // 9. Возвращаем новый access
  return c.json({
    status: "ok",
    access_token,
  });
});

export default app;

