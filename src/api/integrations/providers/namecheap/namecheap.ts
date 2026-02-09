// src/api/integrations/providers/namecheap/namecheap.ts
//
// Адаптер Namecheap API для 301
// - проверка валидности ключа
// - список доменов → для UI 301
// - смена NS на указанные (из CF зоны)
// Работает через Squid прокси (cf.proxy), формат Namecheap = XML

import type { Env } from "../../../types/worker";

// ============================================================
// PROXY TYPES & HELPERS
// ============================================================

export interface SquidProxyConfig {
  url: string;
  ip: string;
}

/**
 * Получает конфиг Squid прокси из KV
 * KV key: "proxy:namecheap" → { "url": "http://user:pass@IP:PORT", "ip": "IP" }
 */
export async function getProxyConfig(env: Env): Promise<SquidProxyConfig | null> {
  const config = await env.KV_CREDENTIALS.get("proxy:namecheap", "json") as SquidProxyConfig | null;
  if (!config || !config.url || !config.ip) return null;
  return config;
}

/**
 * Получает IP прокси для whitelist в Namecheap
 */
export async function getProxyIps(env: Env): Promise<string[]> {
  const config = await getProxyConfig(env);
  return config ? [config.ip] : [];
}

/**
 * Выполняет GET-запрос через Squid прокси (cf.proxy)
 */
async function fetchViaSquidProxy(
  proxyUrl: string,
  targetUrl: string,
  timeoutMs = 10_000
): Promise<{ ok: boolean; body?: string; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      signal: controller.signal,
      // @ts-expect-error cf.proxy is a Cloudflare Workers extension
      cf: { proxy: proxyUrl },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { ok: false, error: `proxy_http_${response.status}` };
    }

    const body = await response.text();
    return { ok: true, body };
  } catch (err: unknown) {
    clearTimeout(timeoutId);

    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "proxy_timeout" };
    }

    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `proxy_error: ${message}` };
  }
}

// ============================================================
// NAMECHEAP API HELPERS
// ============================================================

const NAMECHEAP_API_URL = "https://api.namecheap.com/xml.response";

/** Секреты Namecheap (расшифрованные) */
export interface NamecheapSecrets {
  apiKey: string;
  username: string;
}

/**
 * Строит URL для команды Namecheap API
 */
export function buildNamecheapUrl(
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

// Внутренний helper: XML → JS
function parseXml(xml: string): Document {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");

  if (doc.querySelector("parsererror")) {
    throw new Error("invalid_xml_response");
  }

  return doc;
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
  const proxy = await getProxyConfig(env);
  if (!proxy) {
    return { ok: false, error: "no_proxy_configured" };
  }

  const url = buildNamecheapUrl(secrets.username, secrets.apiKey, proxy.ip, "namecheap.users.getBalances");
  const result = await fetchViaSquidProxy(proxy.url, url);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const xml = parseXml(result.body!);
  const status = xml.querySelector("ApiResponse")?.getAttribute("Status");

  if (status === "OK") {
    const balanceMatch = result.body!.match(/AvailableBalance="([\d.]+)"/);
    return {
      ok: true,
      balance: balanceMatch?.[1],
      proxyIp: proxy.ip,
    };
  }

  // Parse error
  const errorEl = xml.querySelector("Error");
  const errorCode = errorEl?.getAttribute("Number");
  const errorMsg = errorEl?.textContent || "unknown_error";

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
  const proxy = await getProxyConfig(env);
  if (!proxy) {
    return { ok: false, error: "no_proxy_configured" };
  }

  const url = buildNamecheapUrl(secrets.username, secrets.apiKey, proxy.ip, "namecheap.domains.getList");
  const result = await fetchViaSquidProxy(proxy.url, url);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const xml = parseXml(result.body!);
  const status = xml.querySelector("ApiResponse")?.getAttribute("Status");

  if (status !== "OK") {
    const errorEl = xml.querySelector("Error");
    return { ok: false, error: errorEl?.textContent || "unknown_error" };
  }

  const domains: { domain: string; expires: string }[] = [];
  const items = xml.querySelectorAll("Domain");
  items.forEach((item) => {
    domains.push({
      domain: item.getAttribute("Name") || "",
      expires: item.getAttribute("Expires") || "",
    });
  });

  return { ok: true, domains };
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

  const proxy = await getProxyConfig(env);
  if (!proxy) {
    return { ok: false, error: "no_proxy_configured" };
  }

  const { sld, tld } = parseDomain(fqdn);
  const url = buildNamecheapUrl(
    secrets.username,
    secrets.apiKey,
    proxy.ip,
    "namecheap.domains.dns.setCustom",
    {
      SLD: sld,
      TLD: tld,
      Nameservers: nameservers.join(","),
    }
  );
  const result = await fetchViaSquidProxy(proxy.url, url);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const xml = parseXml(result.body!);
  const status = xml.querySelector("ApiResponse")?.getAttribute("Status");

  if (status === "OK") {
    return { ok: true };
  }

  const errorEl = xml.querySelector("Error");
  return { ok: false, error: errorEl?.textContent || "unknown_error" };
}

// Deprecated alias для совместимости
export const namecheapSetNsToCloudflare = namecheapSetNs;
