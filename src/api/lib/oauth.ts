/**
 * lib/oauth.ts
 * Универсальные инструменты для OAuth 2.0 / OIDC провайдеров
 *
 * Поддерживает:
 * - Генерацию PKCE (verifier + challenge)
 * - Создание и проверку state в KV (CSRF-защита)
 * - Безопасную генерацию случайных строк (base64url)
 * - Формирование redirect-URL для авторизации
 * - Валидацию redirect_host по whitelist
 * - Унифицированный TTL и пространство ключей в KV
 *
 * Используется в /auth/oauth/google/*, /auth/oauth/github/* и других.
 */

export const OAUTH_STATE_TTL = 300; // 5 минут
export const OAUTH_NAMESPACE = "oauth";

/**
 * Whitelist разрешённых хостов для OAuth redirect
 * ВАЖНО: изменение списка требует редеплоя
 * @see wiki/API.md — раздел OAuth Redirect Hosts
 */
export const ALLOWED_OAUTH_REDIRECT_HOSTS = [
  "app.301.st",
  "dev.301.st",
  "301.st",
  "localhost:5173",
  "localhost:3000",
] as const;

const DEFAULT_REDIRECT_HOST = "301.st";

/** Base64URL-кодирование массива байтов */
function b64url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Безопасная случайная строка (base64url) */
export function randomString(length = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

/** Генерация PKCE-пары (code_verifier + code_challenge S256) */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(64);
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  const challenge = b64url(digest);
  return { verifier, challenge };
}

/**
 * Валидация redirect_host по whitelist
 * @param host хост из query параметра
 * @returns безопасный хост или fallback
 */
export function validateRedirectHost(host: string | undefined | null): string {
  if (host && (ALLOWED_OAUTH_REDIRECT_HOSTS as readonly string[]).includes(host)) {
    return host;
  }
  return DEFAULT_REDIRECT_HOST;
}

/**
 * Строит финальный redirect URL после успешного OAuth
 * @param host валидированный хост (например "app.301.st")
 * @param token JWT access token
 */
export function buildSuccessRedirectUrl(host: string, token: string): string {
  const protocol = host.startsWith("localhost") ? "http" : "https";
  return `${protocol}://${host}/auth/success?token=${token}`;
}

/** Данные, сохраняемые в KV для OAuth state */
interface OAuthStatePayload {
  verifier: string;
  redirectHost: string;
}

/** Результат consumeState */
export interface OAuthStateData {
  verifier: string;
  redirectHost: string;
}

/**
 * Сохраняет state, code_verifier и redirect_host в KV
 * @param env Cloudflare Env
 * @param provider "google" | "github" | "apple" и т.д.
 * @param state уникальный state (UUID)
 * @param verifier PKCE code_verifier
 * @param redirectHost хост для redirect после OAuth (уже валидированный)
 * @param ttl TTL в секундах (по умолчанию 300)
 */
export async function storeState(
  env: Env,
  provider: string,
  state: string,
  verifier: string,
  redirectHost: string = DEFAULT_REDIRECT_HOST,
  ttl = OAUTH_STATE_TTL
): Promise<void> {
  const key = `${OAUTH_NAMESPACE}:${provider}:state:${state}`;
  const payload: OAuthStatePayload = { verifier, redirectHost };
  await env.KV_SESSIONS.put(key, JSON.stringify(payload), { expirationTtl: ttl });
}

/**
 * Проверяет и удаляет сохранённый state (одноразовое использование)
 * @returns { verifier, redirectHost } или null если не найден/просрочен
 */
export async function consumeState(
  env: Env,
  provider: string,
  state: string
): Promise<OAuthStateData | null> {
  const key = `${OAUTH_NAMESPACE}:${provider}:state:${state}`;
  const raw = await env.KV_SESSIONS.get(key);
  if (!raw) return null;

  await env.KV_SESSIONS.delete(key);

  // Парсим JSON — новый формат
  try {
    const parsed = JSON.parse(raw) as OAuthStatePayload;
    if (typeof parsed === "object" && parsed.verifier) {
      return {
        verifier: parsed.verifier,
        redirectHost: parsed.redirectHost || DEFAULT_REDIRECT_HOST,
      };
    }
  } catch {
    // Fallback: старый формат — только verifier как строка
  }

  // Обратная совместимость: если это просто строка (старый формат)
  return {
    verifier: raw,
    redirectHost: DEFAULT_REDIRECT_HOST,
  };
}

/**
 * Формирует redirect-URL для начала авторизации
 * @param baseUrl OAuth endpoint (например, https://accounts.google.com/o/oauth2/v2/auth)
 * @param params объект параметров (client_id, redirect_uri, scope, state и т.д.)
 */
export function buildOAuthUrl(baseUrl: string, params: Record<string, string>): string {
  const url = new URL(baseUrl);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return url.toString();
}

/**
 * Унифицированный helper для обмена code → tokens
 * @param tokenUrl OAuth token endpoint
 * @param body тело POST-запроса (в виде URLSearchParams)
 * @returns JSON-ответ или null
 */
export async function exchangeToken(tokenUrl: string, body: URLSearchParams): Promise<any | null> {
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!resp.ok) return null;
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * @deprecated Используй buildSuccessRedirectUrl() вместо этого
 * Унифицированный redirect на фронтенд после успешной авторизации
 */
export function successRedirect(baseRedirect: string, accessToken: string): Response {
  const redirectUrl = `${baseRedirect}?token=${accessToken}`;
  return new Response(null, {
    status: 302,
    headers: { Location: redirectUrl },
  });
}
