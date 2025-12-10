// src/api/integrations/providers/namecheap/initkey.ts

import { Context } from "hono";
import { Env } from "../../../types/worker";
import { encrypt } from "../../../lib/crypto";
import { requireOwner } from "../../../lib/auth";

// TYPES

interface InitKeyRequest {
  username: string;
  api_key: string;
  key_alias?: string;
}

interface ProxyConfig {
  ip: string;
  port: number;
  user: string;
  pass: string;
}

interface NamecheapResponse {
  ok: boolean;
  error?: string;
  balance?: string;
}

// PROXY HELPERS

/**
 * Парсит строку прокси формата "IP:PORT:USER:PASS"
 */
function parseProxy(proxyString: string): ProxyConfig | null {
  const parts = proxyString.split(":");
  if (parts.length !== 4) return null;

  const [ip, portStr, user, pass] = parts;
  const port = parseInt(portStr, 10);

  if (!ip || isNaN(port) || !user || !pass) return null;

  return { ip, port, user, pass };
}

/**
 * Получает список прокси из KV
 */
async function getProxies(env: Env): Promise<ProxyConfig[]> {
  const raw = await env.KV_CREDENTIALS.get("proxies:namecheap", "json") as string[] | null;

  if (!raw || !Array.isArray(raw)) {
    return [];
  }

  const proxies: ProxyConfig[] = [];
  for (const str of raw) {
    const parsed = parseProxy(str);
    if (parsed) proxies.push(parsed);
  }

  return proxies;
}

/**
 * Выполняет запрос через прокси с Basic Auth
 */
async function fetchViaProxy(
  proxy: ProxyConfig,
  targetUrl: string,
  timeoutMs: number = 10000
): Promise<{ ok: boolean; body?: string; error?: string }> {
  const proxyUrl = `http://${proxy.ip}:${proxy.port}`;
  const auth = btoa(`${proxy.user}:${proxy.pass}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "text/plain",
      },
      body: targetUrl,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { ok: false, error: `proxy_http_${response.status}` };
    }

    const body = await response.text();
    return { ok: true, body };
  } catch (err: any) {
    clearTimeout(timeoutId);

    if (err.name === "AbortError") {
      return { ok: false, error: "proxy_timeout" };
    }

    return { ok: false, error: `proxy_error: ${err.message}` };
  }
}

/**
 * Выполняет запрос с fallback по списку прокси
 */
async function fetchWithProxyFallback(
  proxies: ProxyConfig[],
  buildUrl: (proxyIp: string) => string
): Promise<{ ok: boolean; body?: string; proxyUsed?: ProxyConfig; error?: string }> {
  if (proxies.length === 0) {
    return { ok: false, error: "no_proxies_configured" };
  }

  for (const proxy of proxies) {
    const url = buildUrl(proxy.ip);
    const result = await fetchViaProxy(proxy, url);

    if (result.ok) {
      return { ok: true, body: result.body, proxyUsed: proxy };
    }

    console.warn(`[Namecheap] Proxy ${proxy.ip}:${proxy.port} failed: ${result.error}`);
  }

  return { ok: false, error: "all_proxies_failed" };
}

// NAMECHEAP API HELPERS

const NAMECHEAP_API_URL = "https://api.namecheap.com/xml.response";

/**
 * Строит URL для команды Namecheap API
 */
function buildNamecheapUrl(
  username: string,
  apiKey: string,
  clientIp: string,
  command: string,
  extraParams?: Record<string, string>
): string {
  const params = new URLSearchParams({
    ApiUser: username,
    ApiKey: apiKey,
    UserName: username,
    ClientIp: clientIp,
    Command: command,
    ...extraParams,
  });

  return `${NAMECHEAP_API_URL}?${params.toString()}`;
}

/**
 * Парсит XML ответ от Namecheap
 */
function parseNamecheapResponse(xml: string): NamecheapResponse {
  // Проверяем Status="OK" или Status="ERROR"
  const statusMatch = xml.match(/Status="(\w+)"/);
  const status = statusMatch?.[1];

  if (status === "OK") {
    // Извлекаем баланс если есть
    const balanceMatch = xml.match(/AvailableBalance="([\d.]+)"/);
    return {
      ok: true,
      balance: balanceMatch?.[1],
    };
  }

  // Парсим ошибку
  const errorMatch = xml.match(/<Error Number="(\d+)"[^>]*>([^<]+)<\/Error>/);
  if (errorMatch) {
    const [, errorCode, errorMessage] = errorMatch;
    
    // Специфичные ошибки
    if (errorCode === "1011150") {
      return { ok: false, error: "invalid_api_key" };
    }
    if (errorCode === "1011118" || errorMessage.includes("IP")) {
      return { ok: false, error: "ip_not_whitelisted" };
    }

    return { ok: false, error: `namecheap_error_${errorCode}: ${errorMessage}` };
  }

  return { ok: false, error: "unknown_namecheap_error" };
}

/**
 * Верифицирует ключ Namecheap через users.getBalances
 */
async function verifyNamecheapKey(
  env: Env,
  username: string,
  apiKey: string
): Promise<{ ok: boolean; error?: string; balance?: string; proxyIp?: string }> {
  const proxies = await getProxies(env);

  const result = await fetchWithProxyFallback(
    proxies,
    (proxyIp) => buildNamecheapUrl(username, apiKey, proxyIp, "namecheap.users.getBalances")
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const parsed = parseNamecheapResponse(result.body!);
  
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  return {
    ok: true,
    balance: parsed.balance,
    proxyIp: result.proxyUsed?.ip,
  };
}

// MAIN HANDLER

/**
 * POST /integrations/namecheap/init
 * 
 * Body: {
 *   username: string,
 *   api_key: string,
 *   key_alias?: string
 * }
 * 
 * Flow:
 * 1. Validate input
 * 2. Get proxies from KV
 * 3. Verify key via namecheap.users.getBalances (with proxy fallback)
 * 4. Encrypt & store in D1 + KV
 * 5. Return success
 */
export async function handleInitKeyNamecheap(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  // 1. Parse & validate input
  let body: InitKeyRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { username, api_key, key_alias } = body;

  if (!username || typeof username !== "string") {
    return c.json({ ok: false, error: "username_required" }, 400);
  }

  if (!api_key || typeof api_key !== "string") {
    return c.json({ ok: false, error: "api_key_required" }, 400);
  }

  // 2. Auth — проверяем JWT и получаем account_id
  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // 3. Verify key via Namecheap API
  const verification = await verifyNamecheapKey(env, username.trim(), api_key.trim());

  if (!verification.ok) {
    // Специфичные сообщения для UI
    if (verification.error === "ip_not_whitelisted") {
      const proxies = await getProxies(env);
      const proxyIps = proxies.map(p => p.ip).join(", ");

      return c.json({
        ok: false,
        error: "ip_not_whitelisted",
        message: "Add these IPs to your Namecheap API whitelist",
        ips: proxyIps,
      }, 400);
    }

    return c.json({
      ok: false,
      error: verification.error,
    }, 400);
  }

  // 4. Check for duplicate (same username for this account)
  const existing = await env.DB301.prepare(
    `SELECT id FROM account_keys 
     WHERE account_id = ? AND provider = 'namecheap' AND external_account_id = ?`
  )
    .bind(accountId, username.trim().toLowerCase())
    .first();

  if (existing) {
    return c.json({
      ok: false,
      error: "namecheap_key_already_exists",
      existing_key_id: existing.id,
    }, 409);
  }

  // 5. Encrypt & store
  const tokenName = key_alias?.trim() || `namecheap-${username}`;

  const secrets = {
    apiKey: api_key.trim(),
    username: username.trim(),
  };

  const encrypted = await encrypt(secrets, env.MASTER_SECRET);

  const result = await env.DB301.prepare(
    `INSERT INTO account_keys 
      (account_id, provider, name, key_encrypted, external_account_id, status, created_at, updated_at)
     VALUES (?, 'namecheap', ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  )
    .bind(
      accountId,
      tokenName,
      JSON.stringify(encrypted),
      username.trim().toLowerCase()
    )
    .run();

  const keyId = result.meta?.last_row_id;

  // 6. Success
  return c.json({
    ok: true,
    key_id: keyId,
    message: "Namecheap integration configured successfully",
    balance: verification.balance,
  });
}

