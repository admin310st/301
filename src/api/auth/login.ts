import { Context } from "hono";
import { compare } from "bcrypt-ts";
import { SignJWT } from "jose";

export async function login(c: Context) {
  const env = c.env;
  const { email, password } = await c.req.json();

  const user = await env.DB301.prepare(
    "SELECT id, password_hash FROM users WHERE email=?"
  )
    .bind(email)
    .first();

  if (!user) return c.json({ error: "User not found" }, 404);
  const valid = await compare(password, user.password_hash);
  if (!valid) return c.json({ error: "Invalid password" }, 401);

  const sessionId = crypto.randomUUID();
  await env.KV_SESSIONS.put(`refresh:${sessionId}`, String(user.id), {
    expirationTtl: 60 * 60 * 24 * 7,
  });

  const secret = new TextEncoder().encode(env.JWT_SECRET || "dev_secret");
  const accessToken = await new SignJWT({ user_id: user.id })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("15m")
    .sign(secret);

  c.header(
    "Set-Cookie",
    `refresh_id=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`
  );

  return c.json({ access_token: accessToken });
}

