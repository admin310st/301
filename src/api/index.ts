import { Hono } from "hono";
import { corsMiddleware } from "./lib/cors";
import verify from "./auth/verify";
import register from "./auth/register";
import login from "./auth/login";
import refresh from "./auth/refresh";
import logout from "./auth/logout";
import me from "./auth/me";
import resetPassword from "./auth/reset_password";
import confirmPassword from "./auth/confirm_password";
import keysRouter from "./integrations/keys/router";
import googleStart from "./auth/oauth/google/start";
import googleCallback from "./auth/oauth/google/callback";
import githubStart from "./auth/oauth/github/start";
import githubCallback from "./auth/oauth/github/callback";
import { handleInitKeyCF } from "./integrations/providers/cloudflare/initkey";
import { handleInitKeyNamecheap } from "./integrations/providers/namecheap/initkey";


const app = new Hono<{ Bindings: Env }>();

app.use("*", corsMiddleware);

// --- Auth endpoints ---
app.route("/auth/verify", verify);
app.route("/auth/register", register);
app.route("/auth/login", login);
app.route("/auth/refresh", refresh);
app.route("/auth/logout", logout);
app.route("/auth/me", me);
app.route("/auth/reset_password", resetPassword);
app.route("/auth/confirm_password", confirmPassword);
app.route("/auth/oauth/google/start", googleStart);
app.route("/auth/oauth/google/callback", googleCallback);
app.route("/auth/oauth/github/start", githubStart);
app.route("/auth/oauth/github/callback", githubCallback);

// --- Integrations ---
app.route("/integrations/keys", keysRouter);
app.post("/integrations/cloudflare/init", handleInitKeyCF);
app.post("/integrations/namecheap/init", handleInitKeyNamecheap);

export default app;
