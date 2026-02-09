// src/api/integrations/providers/namecheap/namecheap.ts
//
// Адаптер Namecheap API для 301
// - проверка валидности ключа
// - список доменов → для UI 301
// - смена NS на указанные (из CF зоны)
// Работает через Traefik relay (relay.301.st), формат Namecheap = XML

import type { Env } from "../../../types/worker";

// ============================================================
// RELAY TYPES & HELPERS
// ============================================================

export interface RelayConfig {
  relay_url: string;   // "https://relay.301.st"
  relay_host: string;  // "relay.301.st" (для Host header и TLS SNI)
  relay_auth: string;  // "Basic base64(apiuser:pass)"
  ip: string;          // "51.68.21.133" (для ClientIp в Namecheap и прямого fetch)
}

/**
 * Получает конфиг relay из KV
 * KV key: "proxy:namecheap" → { "relay_url": "...", "relay_auth": "...", "ip": "..." }
 */
export async function getRelayConfig(env: Env): Promise<RelayConfig | null> {
  const config = await env.KV_CREDENTIALS.get("proxy:namecheap", "json") as RelayConfig | null;
  if (!config || !config.relay_url || !config.relay_auth || !config.ip || !config.relay_host) return null;
  return config;
}

/**
 * Получает IP relay-сервера для whitelist в Namecheap
 */
export async function getRelayIps(env: Env): Promise<string[]> {
  const config = await getRelayConfig(env);
  return config ? [config.ip] : [];
}

/**
 * Выполняет GET-запрос через Traefik relay
 */
async function fetchViaRelay(
  relay: RelayConfig,
  targetPath: string,
  timeoutMs = 10_000
): Promise<{ ok: boolean; body?: string; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Fetch через hostname — Traefik требует корректный SNI для роутинга
    const url = `${relay.relay_url}${targetPath}`;
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Authorization: relay.relay_auth,
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { ok: false, error: `relay_http_${response.status}` };
    }

    const body = await response.text();
    return { ok: true, body };
  } catch (err: unknown) {
    clearTimeout(timeoutId);

    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "relay_timeout" };
    }

    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `relay_error: ${message}` };
  }
}

// ============================================================
// NAMECHEAP API HELPERS
// ============================================================

/** Секреты Namecheap (расшифрованные) */
export interface NamecheapSecrets {
  apiKey: string;
  username: string;
}

/**
 * Строит path+query для команды Namecheap API (без host)
 */
export function buildNamecheapPath(
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

  return `/xml.response?${params.toString()}`;
}

// Внутренние XML-хелперы (regex, DOMParser недоступен в Workers)

function xmlAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, "i");
  return re.exec(xml)?.[1] ?? null;
}

function xmlError(xml: string): { code: string | null; message: string } {
  const m = /<Error\s+Number="([^"]*)"[^>]*>([\s\S]*?)<\/Error>/i.exec(xml);
  return m ? { code: m[1], message: m[2].trim() } : { code: null, message: "unknown_error" };
}

function xmlDomains(xml: string): { domain: string; expires: string }[] {
  const results: { domain: string; expires: string }[] = [];
  const re = /<Domain\s[^>]*Name="([^"]*)"[^>]*Expires="([^"]*)"[^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    results.push({ domain: m[1], expires: m[2] });
  }
  return results;
}

// Helper: разбить зону на SLD и TLD
// zoneName приходит из CF — уже правильный рутовый домен
// example.com → sld=example, tld=com
// example.co.uk → sld=example, tld=co.uk
function parseDomain(zoneName: string): { sld: string; tld: string } {
  const parts = zoneName.toLowerCase().split(".");
  if (parts.length < 2) {
    throw new Error("invalid_domain");
  }
  return {
    sld: parts[0],
    tld: parts.slice(1).join("."),
  };
}

// ============================================================
// NAMECHEAP API FUNCTIONS
// ============================================================

// 1) Проверка ключа Namecheap
export async function namecheapVerifyKey(
  env: Env,
  secrets: NamecheapSecrets
): Promise<{ ok: boolean; error?: string; balance?: string; proxyIp?: string }> {
  const relay = await getRelayConfig(env);
  if (!relay) {
    return { ok: false, error: "no_relay_configured" };
  }

  const path = buildNamecheapPath(secrets.username, secrets.apiKey, relay.ip, "namecheap.users.getBalances");
  const result = await fetchViaRelay(relay, path);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const body = result.body!;
  const status = xmlAttr(body, "ApiResponse", "Status");

  if (status === "OK") {
    const balanceMatch = body.match(/AvailableBalance="([\d.]+)"/);
    return {
      ok: true,
      balance: balanceMatch?.[1],
      proxyIp: relay.ip,
    };
  }

  // Parse error
  const { code: errorCode, message: errorMsg } = xmlError(body);

  if (errorCode === "1011150") {
    return { ok: false, error: "invalid_api_key" };
  }
  if (errorCode === "1011118" || errorMsg.includes("IP")) {
    return { ok: false, error: "ip_not_whitelisted" };
  }

  return { ok: false, error: `namecheap_error_${errorCode}: ${errorMsg}` };
}

// 2) Получение списка доменов
export async function namecheapListDomains(
  env: Env,
  secrets: NamecheapSecrets
): Promise<{ ok: boolean; domains?: { domain: string; expires: string }[]; error?: string }> {
  const relay = await getRelayConfig(env);
  if (!relay) {
    return { ok: false, error: "no_relay_configured" };
  }

  const path = buildNamecheapPath(secrets.username, secrets.apiKey, relay.ip, "namecheap.domains.getList");
  const result = await fetchViaRelay(relay, path);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const body = result.body!;
  const status = xmlAttr(body, "ApiResponse", "Status");

  if (status !== "OK") {
    const { message } = xmlError(body);
    return { ok: false, error: message };
  }

  return { ok: true, domains: xmlDomains(body) };
}

// 3) Смена NS на указанные (из CF зоны)
export async function namecheapSetNs(
  env: Env,
  secrets: NamecheapSecrets,
  fqdn: string,
  nameservers: string[]
): Promise<{ ok: boolean; error?: string }> {
  if (!nameservers.length) {
    return { ok: false, error: "no_nameservers" };
  }

  const relay = await getRelayConfig(env);
  if (!relay) {
    return { ok: false, error: "no_relay_configured" };
  }

  const { sld, tld } = parseDomain(fqdn);
  const path = buildNamecheapPath(
    secrets.username,
    secrets.apiKey,
    relay.ip,
    "namecheap.domains.dns.setCustom",
    {
      SLD: sld,
      TLD: tld,
      Nameservers: nameservers.join(","),
    }
  );
  const result = await fetchViaRelay(relay, path);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const body = result.body!;
  const status = xmlAttr(body, "ApiResponse", "Status");

  if (status === "OK") {
    return { ok: true };
  }

  const { message } = xmlError(body);
  return { ok: false, error: message };
}

// Deprecated alias для совместимости
export const namecheapSetNsToCloudflare = namecheapSetNs;
