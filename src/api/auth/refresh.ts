// src/api/auth/refresh.ts
import type { Context } from "hono";
import { signJWT } from "../lib/jwt";
import { nanoid } from "nanoid";

export async function refresh(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  
  // Проверка секретов в production
  const isProduction = env.ENVIRONMENT === 'production';
  
  if (isProduction && !env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required in production. Run: wrangler secret put JWT_SECRET');
  }
  
  if (isProduction && !env.MASTER_SECRET) {
    throw new Error('MASTER_SECRET is required in production. Run: wrangler secret put MASTER_SECRET');
  }

  const cookies = c.req.header("Cookie") || "";
  const match = cookies.match(/refresh_id=([^;]+)/);
  if (!match) {
    return c.json({ error: "no_refresh_token" }, 401);
  }

  const refresh_id = match[1];

  const user_id_str = await env.KV_SESSIONS.get(`refresh:${refresh_id}`);
  if (!user_id_str) {
    return c.json({ error: "invalid_refresh_token" }, 401);
  }

  const user_id = parseInt(user_id_str, 10);

  const session = await env.DB301.prepare(
    "SELECT * FROM sessions WHERE refresh_id=? AND revoked=0"
  ).bind(refresh_id).first();

  if (!session) {
    return c.json({ error: "session_revoked" }, 401);
  }

  const account = await env.DB301.prepare(
    "SELECT id FROM accounts WHERE user_id=? LIMIT 1"
  ).bind(user_id).first();

  if (!account) {
    return c.json({ error: "no_account" }, 500);
  }

  const account_id = Number(account.id);
  const new_refresh_id = nanoid();

  //  race condition
  //  Сначала создаём новый токен в KV
  await env.KV_SESSIONS.put(`refresh:${new_refresh_id}`, String(user_id), {
    expirationTtl: 60 * 60 * 24 * 7,
  });

  // Обновляем запись в D1
  await env.DB301.prepare(
    "UPDATE sessions SET refresh_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(new_refresh_id, session.id).run();

  // Только после успеха удаляем старый токен
  await env.KV_SESSIONS.delete(`refresh:${refresh_id}`);

  // Разделение ключей - JWT_SECRET для токенов, MASTER_SECRET для шифрования данных
  const jwtSecret = env.JWT_SECRET || "dev-jwt-secret-min-32-chars-for-local-development-only";
  
  if (!env.JWT_SECRET) {
    console.warn("JWT_SECRET not set! Using dev fallback. Run: wrangler secret put JWT_SECRET");
  }

  const access_token = await signJWT(
    { user_id, account_id, role: "user" },
    jwtSecret,
    "15m"
  );

  const cookie = `refresh_id=${new_refresh_id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`;
  c.header("Set-Cookie", cookie);

  return c.json({ access_token });
}
