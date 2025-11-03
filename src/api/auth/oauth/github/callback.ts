/**
 * GitHub OAuth 2.0 Callback
 *
 * Endpoint:
 * - GET /auth/oauth/github/callback
 *
 * Flow:
 * 1. Проверка state (CSRF)
 * 2. Обмен code → access_token
 * 3. Получение профиля пользователя GitHub
 * 4. Создание / обновление пользователя
 * 5. Генерация JWT и установка refresh-cookie
 */

import { Hono } from "hono";
import { consumeState } from "../../../lib/oauth";
import { signJWT } from "../../../lib/jwt";

const app = new Hono();

app.get("/", async (c) => {
  try {
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      return c.text("Missing OAuth parameters", 400);
    }

    // Проверяем сохранённый state
    const valid = await consumeState(c.env, "github", state);
    if (!valid) {
      return c.text("Invalid or expired state", 400);
    }

    const client_id = c.env.GITHUB_CLIENT_ID;
    const client_secret = c.env.GITHUB_CLIENT_SECRET;
    const redirect_base = c.env.OAUTH_REDIRECT_BASE || "https://api.301.st";
    const redirect_uri = `${redirect_base}/auth/oauth/github/callback`;

    // Обмен code → access_token
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        client_id,
        client_secret,
        code,
        redirect_uri,
        state,
      }),
    });

    if (!tokenRes.ok) {
      return c.text("Failed to exchange token", 500);
    }

    const tokenData = await tokenRes.json();
    const access_token = tokenData.access_token;
    if (!access_token) {
      return c.text("Missing access_token", 500);
    }

    // Получаем профиль пользователя GitHub
    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const user = await userRes.json();

    // Основные данные
    const email = user.email || "";
    const name = user.name || user.login;
    const sub = `github:${user.id}`;

    // Генерация JWT
    const jwt = await signJWT({ email, name, sub, provider: "github" }, c.env);

    // Редирект в панель управления
    const redirectTo = `${redirect_base}/auth/success?token=${jwt}`;
    return Response.redirect(redirectTo, 302);
  } catch (err) {
    console.error("GitHub OAuth callback error:", err);
    return c.text("OAuth callback failed", 500);
  }
});

export default app;

