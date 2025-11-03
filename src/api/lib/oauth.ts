/**
 * lib/oauth.ts
 * Универсальные инструменты для OAuth 2.0 / OIDC провайдеров
 *
 * Поддерживает:
 * - Генерацию PKCE (verifier + challenge)
 * - Создание и проверку state в KV (CSRF-защита)
 * - Безопасную генерацию случайных строк (base64url)
 * - Формирование redirect-URL для авторизации
 * - Унифицированный TTL и пространство ключей в KV
 *
 * Используется в /auth/oauth/google/*, /auth/oauth/github/* и других.
 */

export const OAUTH_STATE_TTL = 300 // 5 минут
export const OAUTH_NAMESPACE = 'oauth'

/** Base64URL-кодирование массива байтов */
function b64url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let str = ''
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i])
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Безопасная случайная строка (base64url) */
export function randomString(length = 32): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return b64url(bytes)
}

/** Генерация PKCE-пары (code_verifier + code_challenge S256) */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(64)
  const encoder = new TextEncoder()
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier))
  const challenge = b64url(digest)
  return { verifier, challenge }
}

/**
 * Сохраняет state и code_verifier в KV для одноразового использования
 * @param env Cloudflare Env
 * @param provider "google" | "github" | "apple" и т.д.
 * @param state уникальный state
 * @param verifier PKCE code_verifier
 * @param ttl TTL в секундах (по умолчанию 300)
 */
export async function storeState(
  env: Env,
  provider: string,
  state: string,
  verifier: string,
  ttl = OAUTH_STATE_TTL
): Promise<void> {
  const prefix = `${OAUTH_NAMESPACE}:${provider}:state:${state}`
  await env.KV_SESSIONS.put(prefix, verifier, { expirationTtl: ttl })
}

/**
 * Проверяет и удаляет сохранённый state (одноразовое использование)
 * @returns code_verifier или null, если не найден/просрочен
 */
export async function consumeState(
  env: Env,
  provider: string,
  state: string
): Promise<string | null> {
  const prefix = `${OAUTH_NAMESPACE}:${provider}:state:${state}`
  const verifier = await env.KV_SESSIONS.get(prefix)
  if (!verifier) return null
  await env.KV_SESSIONS.delete(prefix)
  return verifier
}

/**
 * Формирует redirect-URL для начала авторизации
 * @param baseUrl OAuth endpoint (например, https://accounts.google.com/o/oauth2/v2/auth)
 * @param params объект параметров (client_id, redirect_uri, scope, state и т.д.)
 */
export function buildOAuthUrl(baseUrl: string, params: Record<string, string>): string {
  const url = new URL(baseUrl)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return url.toString()
}

/**
 * Унифицированный helper для обмена code → tokens
 * @param tokenUrl OAuth token endpoint
 * @param body тело POST-запроса (в виде URLSearchParams)
 * @returns JSON-ответ или null
 */
export async function exchangeToken(tokenUrl: string, body: URLSearchParams): Promise<any | null> {
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body
  })
  if (!resp.ok) return null
  try {
    return await resp.json()
  } catch {
    return null
  }
}

/**
 * Унифицированный redirect на фронтенд после успешной авторизации
 * @param baseRedirect базовый URL, например https://app.301.st/login/success
 * @param accessToken JWT-токен
 */
export function successRedirect(baseRedirect: string, accessToken: string): Response {
  const redirectUrl = `${baseRedirect}?token=${accessToken}`
  return new Response(null, {
    status: 302,
    headers: { Location: redirectUrl }
  })
}

