// src/api/lib/cors.ts
import { cors } from "hono/cors";

export const corsMiddleware = cors({
  origin: (origin) => {
    // Нет origin в запросе → отклоняем
    if (!origin) return false;

    const allowed = [
      "https://301.st",
      "https://app.301.st",
      "https://api.301.st",
      "https://dev.301.st",
      "http://localhost:8787",
      "http://127.0.0.1:8787",
    ];

    // 1. Проверка wildcard поддоменов
    if (origin.endsWith(".webstudio.is")) {
      return origin;
    }

    // 2. Проверка whitelist
    if (allowed.includes(origin)) {
      return origin;
    }

    // 3. Все остальные → запрещены
    return false;
  },
  allowHeaders: ["Accept", "Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
  maxAge: 86400,
});

