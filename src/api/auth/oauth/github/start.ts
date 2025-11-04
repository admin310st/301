/**
 * Инициация GitHub OAuth 2.0 flow
 *
 * Endpoint:
 * - GET /auth/oauth/github/start
 *
 * Flow:
 * 1. Генерация state (CSRF protection)
 * 2. Сохранение state в KV (TTL 5 минут)
 * 3. Редирект на GitHub OAuth
 */

import { Hono } from "hono";
import { storeState } from "../../../lib/oauth";

const app = new Hono();

app.get("/", async (c) => {
  const client_id = c.env.GITHUB_CLIENT_ID;
  const redirect_base = c.env.OAUTH_REDIRECT_BASE || "https://api.301.st";

  if (!client_id) {
    return c.text("OAuth misconfigured: missing GITHUB_CLIENT_ID", 500);
  }

  const state = crypto.randomUUID();

  // GitHub не использует PKCE, сохраняем метку валидности
  await storeState(c.env, "github", state, "verified");

  const redirect_uri = `${redirect_base}/auth/oauth/github/callback`;
  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", client_id);
  authUrl.searchParams.set("redirect_uri", redirect_uri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", "read:user user:email");

  return Response.redirect(authUrl.toString(), 302);
});

export default app;

