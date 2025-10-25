import { Context } from "hono";
import { SignJWT } from "jose";

export async function refresh(c: Context) {
  const env = c.env;
  const cookie = c.req.header("Cookie") || "";
  const refreshMatch = cookie.match(/refresh_id=([^;]+)/);
  if (!refreshMatch) return c.json({ error: "Missing refresh_id" }, 401);

  const oldSessionId = refreshMatch[1];
  const userId = await env.KV_SESSIONS.get(`refresh:${oldSessionId}`);
  if (!userId) return c.json({ error: "Invalid or expired refresh token" }, 401);

  const newSessionId = crypto.randomUUID();
  await env.KV_SESSIONS.put(`refresh:${newSessionId}`, userId, {
    expirationTtl: 60 * 60 * 24 * 7,
  });
  await env.KV_SESSIONS.delete(`refresh:${oldSessionId}`);

  const secret = new TextEncoder().encode(env.JWT_SECRET || "dev_secret");
  const accessToken = await new SignJWT({ user_id: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("15m")
    .sign(secret);

  c.header(
    "Set-Cookie",
    `refresh_id=${newSessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`
  );

  return c.json({ access_token: accessToken });
}

