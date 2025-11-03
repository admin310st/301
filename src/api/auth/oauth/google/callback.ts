/**
 * Google OAuth 2.0 Callback
 *
 * Endpoint:
 * - GET /auth/oauth/google/callback
 *
 * Flow:
 * 1. Проверка state (CSRF)
 * 2. Обмен code → access_token + id_token
 * 3. Извлечение данных профиля
 * 4. Создание / обновление пользователя
 * 5. Генерация JWT и установка refresh-cookie
 */

import { Hono } from "hono";
import { consumeState, exchangeToken, successRedirect } from "../../../lib/oauth";
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

    // Проверяем сохранённый state в KV
    const valid = await consumeState(c.env, "google", state);
    if (!valid) {
      return c.text("Invalid or expired state", 400);
    }

    const client_id = c.env.GOOGLE_CLIENT_ID;
    const client_secret = c.env.GOOGLE_CLIENT_SECRET;
    const redirect_base = c.env.OAUTH_REDIRECT_BASE || "https://api.301.st";
    const redirect_uri = `${redirect_base}/auth/oauth/google/callback`;

    // Обмен code → токены
    const tokenData = await exchangeToken("https://oauth2.googleapis.com/token", {
      client_id,
      client_secret,
      code,
      redirect_uri,
    });

    // Извлекаем данные пользователя из id_token
    const { email, name, sub } = tokenData.user;

    // Создаём JWT
    const jwt = await signJWT({ email, name, sub, provider: "google" }, c.env);

    // Редирект в панель управления с токеном
    return successRedirect(c, jwt);
  } catch (err) {
    console.error("OAuth callback error:", err);
    return c.text("OAuth callback failed", 500);
  }
});

export default app;

