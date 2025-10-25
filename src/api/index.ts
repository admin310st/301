import { Hono } from "hono";
import { register } from "./auth/register";
import { login } from "./auth/login";
import { refresh } from "./auth/refresh";
import { logout } from "./auth/logout";
import { me } from "./auth/me";

const app = new Hono();

app.post("/auth/register", register);
app.post("/auth/login", login);
app.post("/auth/refresh", refresh);
app.post("/auth/logout", logout);
app.get("/auth/me", me);

export default app;

