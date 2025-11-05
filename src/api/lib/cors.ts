// src/api/lib/cors.ts
import { cors } from "hono/cors";

export const corsMiddleware = cors({
  origin: (origin) => {
    if (!origin) return false;

    const allowed = [
      "https://301.st",
      "https://app.301.st",
      "https://api.301.st",     // основное API
      "https://dev.301.st",     // тестовый фронтенд
      "http://localhost:8787",  // локальные тесты
      "http://127.0.0.1:8787",  // альтернатива
    ];

    //  *.webstudio.is
    if (origin.endsWith(".webstudio.is")) return true;

    return allowed.includes(origin);
  },
  allowHeaders: ["Accept", "Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
  maxAge: 86400,
});

