import { Hono } from "hono";
import { corsMiddleware } from "./lib/cors";
import { register } from "./auth/register";
import { login } from "./auth/login";
import { refresh } from "./auth/refresh";
import { logout } from "./auth/logout";
import { me } from "./auth/me";
import { keysRouter } from "./integrations/keys/index";

const app = new Hono<{ Bindings: Env }>();

app.use("*", corsMiddleware);

// --- Auth endpoints ---
app.post("/auth/register", register);
app.post("/auth/login", login);
app.post("/auth/refresh", refresh);
app.post("/auth/logout", logout);
app.get("/auth/me", me);

// --- Key endpoint ---
app.route("/integrations/keys", keysRouter);

export default app;
