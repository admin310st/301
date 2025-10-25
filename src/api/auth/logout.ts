import { Context } from "hono";

export async function logout(c: Context) {
  const env = c.env;
  const cookie = c.req.header("Cookie") || "";
  const refreshMatch = cookie.match(/refresh_id=([^;]+)/);

  if (refreshMatch) {
    const sessionId = refreshMatch[1];
    await env.KV_SESSIONS.delete(`refresh:${sessionId}`);
  }

  c.header(
    "Set-Cookie",
    `refresh_id=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
  );

  return c.json({ success: true, message: "Logged out" });
}

