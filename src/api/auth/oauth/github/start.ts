/**
 * GitHub OAuth 2.0 Start
 * GitHub НЕ поддерживает PKCE — используем только state
 * 
 * GET /auth/oauth/github/start?redirect_host=app.301.st
 */

import { Hono } from "hono";
import { storeState, buildOAuthUrl, validateRedirectHost } from "../../../lib/oauth";

const app = new Hono();

app.get("/", async (c) => {
  const client_id = c.env.GITHUB_CLIENT_ID;
  const redirect_base = c.env.OAUTH_REDIRECT_BASE || "https://api.301.st";

  if (!client_id) {
    return c.text("OAuth misconfigured: missing GITHUB_CLIENT_ID", 500);
  }

  // 1. Получение и валидация redirect_host
  const rawRedirectHost = c.req.query("redirect_host");
  const redirectHost = validateRedirectHost(rawRedirectHost);

  // 2. Генерация state
  const state = crypto.randomUUID();

  // 3. Сохраняем state + redirect_host (verifier = placeholder, GitHub не поддерживает PKCE)
  await storeState(c.env, "github", state, "github-no-pkce", redirectHost);

  const redirect_uri = `${redirect_base}/auth/oauth/github/callback`;

  // БЕЗ PKCE параметров — GitHub их игнорирует
  const authUrl = buildOAuthUrl("https://github.com/login/oauth/authorize", {
    client_id,
    redirect_uri,
    state,
    scope: "read:user user:email",
  });

  return Response.redirect(authUrl, 302);
});

export default app;

