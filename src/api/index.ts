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


const app = new Hono<{ Bindings: Env }>();

app.use("*", corsMiddleware);

// --- Auth endpoints ---
app.route("/auth/verify", verify);
app.post("/auth/register", register);
app.post("/auth/login", login);
app.post("/auth/refresh", refresh);
app.post("/auth/logout", logout);
app.get("/auth/me", me);
app.route("/auth/reset_password", resetPassword);
app.route("/auth/confirm_password", confirmPassword);
app.route("/auth/oauth/google/start", googleStart);
app.route("/auth/oauth/google/callback", googleCallback);

// --- Key endpoint ---
app.route("/integrations/keys", keysRouter);

export default app;
