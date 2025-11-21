/**
 * GitHub OAuth 2.0 Start
 * GitHub НЕ поддерживает PKCE — используем только state
 */

import { Hono } from "hono";
import { storeState, buildOAuthUrl } from "../../../lib/oauth";

const app = new Hono();

app.get("/", async (c) => {
  const client_id = c.env.GITHUB_CLIENT_ID;
  const redirect_base = c.env.OAUTH_REDIRECT_BASE || "https://api.301.st";

  if (!client_id) {
    return c.text("OAuth misconfigured: missing GITHUB_CLIENT_ID", 500);
  }

  const state = crypto.randomUUID();

  // Сохраняем state (verifier = "none" — GitHub не поддерживает PKCE)
  await storeState(c.env, "github", state, "github-no-pkce");

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
