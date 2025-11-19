// src/api/auth/refresh.ts
/**
 * 
 * Обновление access-токена по refresh_id (из cookie).
 * Строгая проверка IP и User-Agent для защиты от session hijacking.
 * 
 * Если IP или UA не совпадают → отклоняем запрос + инвалидируем refresh token.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logAuth, logEvent } from "../lib/logger";
import { signJWT } from "../lib/jwt";
import { extractRequestInfo } from "../lib/fingerprint";

const app = new Hono();

app.post("/", async (c) => {
  const env = c.env;

  // Извлечение IP и UA для проверки
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
  const raw = await env.KV_SESSIONS.get(`refresh:${oldRefresh}`);
  
  if (!raw) {
    throw new HTTPException(401, { message: "invalid_refresh" });
  }

  let session: {
    user_id: number;
    account_id?: number | null;
    user_type?: string;
    ip?: string;
    ua?: string;
    created_at?: number;
  };

  try {
    session = JSON.parse(raw);
  } catch {
    throw new HTTPException(401, { message: "invalid_refresh" });
  }

  if (!session || !session.user_id) {
    throw new HTTPException(401, { message: "invalid_refresh" });
  }

  const user_id = session.user_id;
  const account_id = session.account_id ?? null;
  const user_type = session.user_type ?? "client";

  // Строгая проверка IP
  if (session.ip && session.ip !== ip) {
    // IP не совпадает → подозрение на session hijacking
    
    // Логируем попытку
    try {
      await logEvent(env, {
        event_type: "revoke",
        user_id,
        ip,
        ua,
        details: {
          action: "session_hijack_detected",
          reason: "ip_mismatch",
          expected_ip: session.ip,
          actual_ip: ip,
          refresh_id: oldRefresh
        }
      });
    } catch (err) {
      console.error("[AUDIT_LOG ERROR ip_mismatch]", err);
    }

    // Удаляем скомпрометированный refresh token
    await env.KV_SESSIONS.delete(`refresh:${oldRefresh}`);

    throw new HTTPException(401, { 
      message: "session_hijack_detected",
      details: "IP address mismatch"
    } as any);
  }

  // Строгая проверка User-Agent
  if (session.ua && session.ua !== ua) {
    // User-Agent не совпадает → подозрение на session hijacking
    
    // Логируем попытку
    try {
      await logEvent(env, {
        event_type: "revoke",
        user_id,
        ip,
        ua,
        details: {
          action: "session_hijack_detected",
          reason: "ua_mismatch",
          expected_ua: session.ua,
          actual_ua: ua,
          refresh_id: oldRefresh
        }
      });
    } catch (err) {
      console.error("[AUDIT_LOG ERROR ua_mismatch]", err);
    }

    // Удаляем скомпрометированный refresh token
    await env.KV_SESSIONS.delete(`refresh:${oldRefresh}`);

    throw new HTTPException(401, { 
      message: "session_hijack_detected",
      details: "User-Agent mismatch"
    } as any);
  }

  // 3. Проверки прошли - генерируем новый access token с fingerprint
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
    { ip, ua }  // Fingerprint
  );

  // 4. Генерируем новый refresh_id
  const new_refresh_id = crypto.randomUUID();

  // 5. Записываем новый refresh с актуальными IP и UA
  await env.KV_SESSIONS.put(
    `refresh:${new_refresh_id}`,
    JSON.stringify({ 
      user_id, 
      account_id, 
      user_type,
      ip,        // Актуальный IP
      ua,        // Актуальный UA
      created_at: Date.now()
    }),
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

