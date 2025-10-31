// src/api/auth/register.ts
import type { Context } from "hono";
import { z } from "zod";
import { hash } from "bcrypt-ts";
import { signJWT } from "../lib/jwt";
import { nanoid } from "nanoid";

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().optional(),
  turnstile_token: z.string().optional(),
});

export async function register(c: Context<{ Bindings: Env }>) {
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
  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const { email, password, name, turnstile_token } = parsed.data;

  if (env.TURNSTILE_SECRET && turnstile_token) {
    const verifyResp = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `secret=${env.TURNSTILE_SECRET}&response=${turnstile_token}`,
      }
    );
    const verifyData: any = await verifyResp.json();
    if (!verifyData.success) {
      return c.json({ error: "turnstile_failed" }, 403);
    }
  }

  const exists = await env.DB301.prepare(
    "SELECT id FROM users WHERE email=?"
  ).bind(email).first();
  if (exists) {
    return c.json({ error: "email_exists" }, 409);
  }

  const password_hash = await hash(password, 10);
  const userName = name ?? null;

  const userResult = await env.DB301.prepare(
    "INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?) RETURNING id"
  ).bind(email, password_hash, userName).first();

  if (!userResult || !userResult.id) {
    return c.json({ error: "user_creation_failed" }, 500);
  }

  const user_id = Number(userResult.id);
  const account_name = name || email.split("@")[0];

  const accountResult = await env.DB301.prepare(
    "INSERT INTO accounts (user_id, account_name, plan, status) VALUES (?, ?, ?, ?) RETURNING id"
  ).bind(user_id, account_name, "free", "active").first();

  if (!accountResult || !accountResult.id) {
    return c.json({ error: "account_creation_failed" }, 500);
  }

  const account_id = Number(accountResult.id);
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
    .bind(account_id, user_id, "register", JSON.stringify({ ip, ua }), "user")
    .run();

  return c.json(
    {
      access_token,
      user: {
        id: user_id,
        email,
        name: userName,
        account_id,
        role: "user",
      },
    },
    201
  );
}
