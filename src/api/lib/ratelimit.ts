/**
 * lib/ratelimit.ts (production)
 * Централизованный rate limiting для /auth/*.
 * Хранение счётчиков в KV_RATELIMIT.
 * Поддержка двойной защиты: по IP и по email/идентификатору.
 */

import type { Context } from "hono";
import { logEvent } from "./logger"; // необязательно; если нет — закомментируй вызов в handleBlock

// Типы
interface RateLimitConfig {
  max: number;       // максимум попыток
  windowSec: number; // окно в секундах
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number; // сек до сброса (если заблокирован)
}

// Конфигурации лимитов 
export const RATE_LIMITS = {
  // Login endpoints
  LOGIN_BY_IP: { max: 5, windowSec: 300 },       // 5 попыток / 5 минут с IP
  LOGIN_BY_EMAIL: { max: 10, windowSec: 900 },   // 10 попыток / 15 минут для email

  // Register endpoints
  REGISTER_BY_IP: { max: 3, windowSec: 900 },    // 3 регистрации / 15 минут с IP
  REGISTER_BY_EMAIL: { max: 1, windowSec: 300 }, // 1 попытка / 5 минут для email

  // OAuth endpoints
  OAUTH_BY_IP: { max: 10, windowSec: 300 },      // 10 OAuth попыток / 5 минут

  // Refresh token
  REFRESH_BY_IP: { max: 20, windowSec: 60 },     // 20 refresh / 1 минута
} as const;

// Утилиты
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function safeJSON<T = unknown>(str: string | null): T | null {
  if (!str) return null;
  try { return JSON.parse(str) as T; } catch { return null; }
}

function toKVKey(raw: string): string {
  // Нормализуем ключ (v1 — для будущей миграции формата)
  // Ограничиваем длину: используем простой hash (FNV-1a) для стабильности.
  const v = raw.toLowerCase();
  const hash = fnv1a(v);
  return `ratelimit:v1:${hash}`;
}

// Простая fnv1a-хеш-функция
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // Возвращаем в hex
  return ("00000000" + h.toString(16)).slice(-8);
}

// Ядро проверки
export async function checkRateLimit(
  env: Env,
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  // Dev-окружение: отключаем rate-limit
  if (env.ENVIRONMENT !== 'production') {
    return {
      allowed: true,
      remaining: 999,
      resetAt: Math.floor(Date.now() / 1000) + 60
    };
  }

  const now = nowSec();
  const kvKey = toKVKey(`ratelimit:${key}`); // нормализация

  // читаем состояние
  const data = safeJSON<{ count: number; resetAt: number }>(
    await env.KV_RATELIMIT.get(kvKey)
  );
  let count = 0;
  let resetAt = now + config.windowSec;

  if (data && typeof data.count === "number" && typeof data.resetAt === "number") {
    if (data.resetAt > now) {
      count = data.count;
      resetAt = data.resetAt;
    } else {
      // окно истекло
      count = 0;
      resetAt = now + config.windowSec;
    }
  }

  // лимит превышен?
  if (count >= config.max) {
    return {
      allowed: false,
      remaining: 0,
      resetAt,
      retryAfter: Math.max(1, resetAt - now),
    };
  }

  // увеличиваем счётчик
  count += 1;
  await env.KV_RATELIMIT.put(
    kvKey,
    JSON.stringify({ count, resetAt }),
    { expirationTtl: config.windowSec + 60 } // небольшой запас
  );

  return {
    allowed: true,
    remaining: Math.max(0, config.max - count),
    resetAt,
  };
}

// Сброс лимита (админ/тест)
export async function resetRateLimit(env: Env, key: string): Promise<void> {
  const kvKey = toKVKey(`ratelimit:${key}`);
  await env.KV_RATELIMIT.delete(kvKey);
}

// Ответ об ошибке (429)
export function rateLimitError(result: RateLimitResult): Response {
  const retryAfter = String(result.retryAfter ?? 60);
  const reset = String(result.resetAt);

  return new Response(
    JSON.stringify({
      error: "rate_limit_exceeded",
      message: "Too many attempts. Please try again later.",
      retryAfter: Number(retryAfter),
      resetAt: Number(reset)
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": retryAfter,
        "X-RateLimit-Limit": "blocked",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": reset
      }
    }
  );
}

// Доп. хелперы для удобной интеграции в роуты

/**
 * Единая обёртка: запускает checkRateLimit, при блоке — логирует и возвращает 429.
 * @returns null если проход разрешён, либо Response 429.
 */
export async function enforceRate(
  c: Context,
  key: string,
  config: RateLimitConfig,
  auditRoute?: string
): Promise<Response | null> {
  const res = await checkRateLimit(c.env, key, config);
  if (res.allowed) return null;

  await handleBlock(c, res, auditRoute);
  return rateLimitError(res);
}

// Логирование блокировки (без фатала, не влияет на поток)
async function handleBlock(c: Context, res: RateLimitResult, auditRoute?: string) {
  try {
    const ip = c.req.header("CF-Connecting-IP") || "unknown";
    const ua = c.req.header("User-Agent") || "unknown";

    // Если логгер не подключён — можно закомментировать
    await logEvent(c.env, {
      event_type: "revoke",
      ip,
      ua,
      details: { route: auditRoute || c.req.path, reason: "rate_limit_exceeded", ...res }
    });
  } catch {
    // no-op
  }
}

// Готовые guard’ы для /auth/*
// Использование в маршруте: 
//   const block = await registerGuard(c, email); if (block) return block;

/** Guard для /auth/register — двойная защита: IP + EMAIL */
export async function registerGuard(c: Context, email?: string): Promise<Response | null> {
  const ip = c.req.header("CF-Connecting-IP") || "unknown";

  // 1) По IP
  {
    const key = `register:ip:${ip}`;
    const block = await enforceRate(c, key, RATE_LIMITS.REGISTER_BY_IP, "/auth/register");
    if (block) return block;
  }

  // 2) По email (если есть)
  if (email) {
    const key = `register:email:${email}`;
    const block = await enforceRate(c, key, RATE_LIMITS.REGISTER_BY_EMAIL, "/auth/register");
    if (block) return block;
  }

  return null;
}

/** Guard для /auth/login — двойная защита: IP + EMAIL */
export async function loginGuard(c: Context, email?: string): Promise<Response | null> {
  const ip = c.req.header("CF-Connecting-IP") || "unknown";

  // 1) По IP
  {
    const key = `login:ip:${ip}`;
    const block = await enforceRate(c, key, RATE_LIMITS.LOGIN_BY_IP, "/auth/login");
    if (block) return block;
  }

  // 2) По email (если есть)
  if (email) {
    const key = `login:email:${email}`;
    const block = await enforceRate(c, key, RATE_LIMITS.LOGIN_BY_EMAIL, "/auth/login");
    if (block) return block;
  }

  return null;
}

/** Guard для /auth/refresh — только по IP */
export async function refreshGuard(c: Context): Promise<Response | null> {
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const key = `refresh:ip:${ip}`;
  return await enforceRate(c, key, RATE_LIMITS.REFRESH_BY_IP, "/auth/refresh");
}

/** Guard для /auth/* OAuth — только по IP */
export async function oauthGuard(c: Context): Promise<Response | null> {
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const key = `oauth:ip:${ip}`;
  return await enforceRate(c, key, RATE_LIMITS.OAUTH_BY_IP, "/auth/oauth");
}

