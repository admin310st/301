import { Hono } from "hono";
import { register } from "./auth/register";
import { login } from "./auth/login";
import { refresh } from "./auth/refresh";
import { logout } from "./auth/logout";
import { me } from "./auth/me";
import { keysRouter } from "./integrations/keys/index";


const app = new Hono();

// --- Flexible CORS middleware ---
app.use("*", async (c, next) => {
  const origin = c.req.header("Origin") || "";

  // Разрешённые источники (точные и wildcard-домены)

const allowedOrigins = [
  "https://301.st",
  "https://api.301.st",     // 🔓 временно открыт полный доступ к API-домену
  "https://dev.301.st",
  /\.apps\.webstudio\.is$/,
  /\.wstd\.io$/,
  "http://localhost",
  "http://localhost:8787",
  "http://127.0.0.1",
  "http://127.0.0.1:8787",
];

  // Проверка Origin по списку
  const isAllowed = allowedOrigins.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(origin) : pattern === origin
  );

  if (isAllowed) c.header("Access-Control-Allow-Origin", origin);
  c.header("Vary", "Origin");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Обработка preflight-запроса
  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  await next();
});

// --- Auth endpoints ---
app.post("/auth/register", register);
app.post("/auth/login", login);
app.post("/auth/refresh", refresh);
app.post("/auth/logout", logout);
app.get("/auth/me", me);

// --- Key endpiont ---
app.route("/integrations/keys", keysRouter);

export default app;

