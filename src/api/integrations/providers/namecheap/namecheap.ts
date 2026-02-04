// src/api/integrations/providers/namecheap/namecheap.ts
//
// Адаптер Namecheap API для 301
// - проверка валидности ключа
// - список доменов → для UI 301
// - смена NS на указанные (из CF зоны)
// Работает через прокси, формат Namecheap = XML

import { decrypt } from "../../../lib/crypto";
import type { Env } from "../../../types/worker";
import type { ProviderKeyData } from "../../keys/schema";

// ============================================================
// PROXY TYPES & HELPERS
// ============================================================

export interface ProxyConfig {
  ip: string;
  port: number;
  user: string;
  pass: string;
}

/**
 * Парсит строку прокси формата "IP:PORT:USER:PASS"
 */
export function parseProxy(proxyString: string): ProxyConfig | null {
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
export async function getProxies(env: Env): Promise<ProxyConfig[]> {
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
 * Получает список IP прокси для whitelist в Namecheap
 * Хранятся отдельно от gateway credentials
 */
export async function getProxyIps(env: Env): Promise<string[]> {
  const ips = await env.KV_CREDENTIALS.get("proxy-ips:namecheap", "json") as string[] | null;
  return ips && Array.isArray(ips) ? ips : [];
}

/**
 * Выполняет запрос через прокси с Basic Auth
 */
export async function fetchViaProxy(
  proxy: ProxyConfig,
  targetUrl: string,
  timeoutMs: number = 10000
): Promise<{ ok: boolean; body?: string; error?: string }> {
  const scheme = proxy.port === 443 ? "https" : "http";
  const proxyUrl = `${scheme}://${proxy.ip}:${proxy.port}`;
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
export async function fetchWithProxyFallback(
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

// ============================================================
// NAMECHEAP API HELPERS
// ============================================================

const NAMECHEAP_API_URL = "https://api.namecheap.com/xml.response";

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
  encrypted: any
): Promise<{ ok: boolean; error?: string; balance?: string; proxyIp?: string }> {
  const data = await decrypt<ProviderKeyData>(encrypted, env.MASTER_SECRET);
  const proxies = await getProxies(env);

  const result = await fetchWithProxyFallback(
    proxies,
    (proxyIp) => buildNamecheapUrl(data.username, data.apiKey, proxyIp, "namecheap.users.getBalances")
  );

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
      proxyIp: result.proxyUsed?.ip,
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
  encrypted: any
): Promise<{ ok: boolean; domains?: { domain: string; expires: string }[]; error?: string }> {
  const data = await decrypt<ProviderKeyData>(encrypted, env.MASTER_SECRET);
  const proxies = await getProxies(env);

  const result = await fetchWithProxyFallback(
    proxies,
    (proxyIp) => buildNamecheapUrl(data.username, data.apiKey, proxyIp, "namecheap.domains.getList")
  );

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
  encrypted: any,
  fqdn: string,
  nameservers: string[]
): Promise<{ ok: boolean; error?: string }> {
  if (!nameservers.length) {
    return { ok: false, error: "no_nameservers" };
  }

  const data = await decrypt<ProviderKeyData>(encrypted, env.MASTER_SECRET);
  const proxies = await getProxies(env);
  const { sld, tld } = parseDomain(fqdn);

  const result = await fetchWithProxyFallback(
    proxies,
    (proxyIp) => buildNamecheapUrl(
      data.username,
      data.apiKey,
      proxyIp,
      "namecheap.domains.dns.setCustom",
      {
        SLD: sld,
        TLD: tld,
        Nameservers: nameservers.join(","),
      }
    )
  );

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
