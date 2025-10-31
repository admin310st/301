// src/api/auth/login.ts
import type { Context } from "hono";
import { z } from "zod";
import { compare } from "bcrypt-ts";
import { signJWT } from "../lib/jwt";
import { nanoid } from "nanoid";

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export async function login(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  
  // Проверка секретов в production
  const isProduction = env.ENVIRONMENT === 'production';
  
  if (isProduction && !env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required in production. Run: wrangler secret put JWT_SECRET');
  }
  
  if (isProduction && !env.MASTER_SECRET) {
    throw new Error('MASTER_SECRET is required in production. Run: wrangler secret put MASTER_SECRET');
  }
  
  const ip = c.req.header("CF-Connecting-IP") || "0.0.0.0";
  const ua = c.req.header("User-Agent") || "unknown";

  const body = await c.req.json();
  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const { email, password } = parsed.data;

  const user = await env.DB301.prepare(
    "SELECT id, email, password_hash, name FROM users WHERE email=?"
  ).bind(email).first();

  if (!user) {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const valid = await compare(password, user.password_hash as string);
  if (!valid) {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const account = await env.DB301.prepare(
    "SELECT id FROM accounts WHERE user_id=? LIMIT 1"
  ).bind(user.id).first();

  if (!account) {
    return c.json({ error: "no_account" }, 500);
  }

  const account_id = Number(account.id);
  const user_id = Number(user.id);
  const refresh_id = nanoid();

  await env.DB301.prepare(
    "INSERT INTO sessions (user_id, refresh_id, ip_address, user_agent, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+7 day'))"
  ).bind(user_id, refresh_id, ip, ua).run();

  await env.KV_SESSIONS.put(`refresh:${refresh_id}`, String(user_id), {
    expirationTtl: 60 * 60 * 24 * 7,
  });

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

  const cookie = `refresh_id=${refresh_id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`;
  c.header("Set-Cookie", cookie);

  await env.DB301.prepare(
    "INSERT INTO audit_log (account_id, user_id, action, details, role) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(account_id, user_id, "login", JSON.stringify({ ip, ua }), "user")
    .run();

  return c.json({
    access_token,
    user: {
      id: user_id,
      email: user.email,
      name: user.name ?? null,
      account_id,
      role: "user",
    },
  });
}
