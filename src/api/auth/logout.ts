// src/api/auth/logout.ts
import type { Context } from "hono";

export async function logout(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  const cookies = c.req.header("Cookie") || "";
  const match = cookies.match(/refresh_id=([^;]+)/);
  
  let user_id = null;
  let account_id = null;
  
  if (match) {
    const refresh_id = match[1];

    // Получаем user_id ДО удаления для аудита
    const user_id_str = await env.KV_SESSIONS.get(`refresh:${refresh_id}`);
    if (user_id_str) {
      user_id = parseInt(user_id_str, 10);
      
      // Получаем account_id для полного аудита
      const account = await env.DB301.prepare(
        "SELECT id FROM accounts WHERE user_id=? LIMIT 1"
      ).bind(user_id).first();
      
      if (account) {
        account_id = Number(account.id);
      }
    }

    // Удаляем токен из KV и помечаем сессию как отозванную
    await env.KV_SESSIONS.delete(`refresh:${refresh_id}`);

    await env.DB301.prepare(
      "UPDATE sessions SET revoked=1, updated_at=CURRENT_TIMESTAMP WHERE refresh_id=?"
    ).bind(refresh_id).run();

    // Логируем событие logout
    if (user_id && account_id) {
      await env.DB301.prepare(
        "INSERT INTO audit_log (account_id, user_id, action, details, role) VALUES (?, ?, ?, ?, ?)"
      ).bind(
        account_id,
        user_id,
        "logout",
        JSON.stringify({
          ip: c.req.header("CF-Connecting-IP") || "unknown",
          ua: c.req.header("User-Agent") || "unknown"
        }),
        "user"
      ).run();
    }
  }

  const cookie = "refresh_id=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
  c.header("Set-Cookie", cookie);

  return c.json({ message: "logged_out" });
}
