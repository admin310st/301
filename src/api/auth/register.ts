import { Context } from "hono";
import { z } from "zod";
import { hash } from "bcrypt-ts";
import { SignJWT } from "jose";

export async function register(c: Context) {
  const env = c.env;
  const body = await c.req.json();

  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid input" }, 400);

  const { email, password } = parsed.data;

  // Проверка существования пользователя
  const existing = await env.DB301.prepare("SELECT id FROM users WHERE email=?")
    .bind(email)
    .first();
  if (existing) return c.json({ error: "Email already registered" }, 409);

  // Хэш пароля
  const password_hash = await hash(password, 10);

  // Создание пользователя
  const result = await env.DB301.prepare(
    "INSERT INTO users (email, password_hash) VALUES (?, ?)"
  )
    .bind(email, password_hash)
    .run();

  const user_id = result.lastRowId;
  const sessionId = crypto.randomUUID();

  // Сохраняем refresh токен
  await env.KV_SESSIONS.put(`refresh:${sessionId}`, String(user_id), {
    expirationTtl: 60 * 60 * 24 * 7,
  });

  // Access token
  const secret = new TextEncoder().encode(env.JWT_SECRET || "dev_secret");
  const accessToken = await new SignJWT({ user_id })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("15m")
    .sign(secret);

  c.header(
    "Set-Cookie",
    `refresh_id=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`
  );

  return c.json({ access_token: accessToken });
}

