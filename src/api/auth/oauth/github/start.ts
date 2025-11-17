/**
 * Инициация GitHub OAuth 2.0 flow с PKCE
 *
 * Endpoint:
 * - GET /auth/oauth/github/start
 *
 * Flow:
 * 1. Генерация state (CSRF protection)
 * 2. Генерация PKCE (verifier + challenge)
 * 3. Сохранение verifier в KV (TTL 5 минут)
 * 4. Редирект на GitHub OAuth с PKCE challenge
 */

import { Hono } from "hono";
import { storeState, generatePKCE, buildOAuthUrl } from "../../../lib/oauth";

const app = new Hono();

app.get("/", async (c) => {
  const client_id = c.env.GITHUB_CLIENT_ID;
  const redirect_base = c.env.OAUTH_REDIRECT_BASE || "https://api.301.st";

  if (!client_id) {
    return c.text("OAuth misconfigured: missing GITHUB_CLIENT_ID", 500);
  }

  const state = crypto.randomUUID();

  // Генерация PKCE
  const { verifier, challenge } = await generatePKCE();
  await storeState(c.env, "github", state, verifier);

  const redirect_uri = `${redirect_base}/auth/oauth/github/callback`;
  
  // Добавление PKCE параметров в URL
  const authUrl = buildOAuthUrl("https://github.com/login/oauth/authorize", {
    client_id,
    redirect_uri,
    state,
    scope: "read:user user:email",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  return Response.redirect(authUrl, 302);
});

export default app;

