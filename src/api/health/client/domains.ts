/**
 * Domains Helper
 *
 * Получение списка активных доменов для проверки.
 * Источники:
 * 1. API 301.st (если настроен API_301_URL)
 * 2. Локальная таблица domain_list (если синхронизирована)
 */

import type { Env } from "./index";

// ============================================================
// TYPES
// ============================================================

interface DomainInfo {
  domain_name: string;
  role?: string; // 'acceptor' | 'donor' | 'reserve'
  zone_id?: string;
}

interface API301DomainsResponse {
  ok: boolean;
  domains?: DomainInfo[];
  error?: string;
}

// ============================================================
// GET ACTIVE DOMAINS
// ============================================================

/**
 * Получить список активных доменов для проверки
 *
 * Приоритет:
 * 1. Из API 301.st (если настроен)
 * 2. Из локальной таблицы domain_list
 * 3. Из domain_threats (домены которые уже проверялись)
 */
export async function getActiveDomains(env: Env): Promise<string[]> {
  // 1. Try API 301.st
  if (env.API_301_URL) {
    const apiDomains = await fetchDomainsFromAPI(env);
    if (apiDomains.length > 0) {
      return apiDomains;
    }
  }

  // 2. Try local domain_list table
  const localDomains = await getDomainsFromLocalDB(env);
  if (localDomains.length > 0) {
    return localDomains;
  }

  // 3. Fallback: domains from domain_threats (re-check known domains)
  const knownDomains = await getKnownDomains(env);
  return knownDomains;
}

/**
 * Запросить домены из API 301.st
 */
async function fetchDomainsFromAPI(env: Env): Promise<string[]> {
  if (!env.API_301_URL) {
    return [];
  }

  try {
    // GET /domains?role=acceptor,donor&active=1
    const url = new URL("/api/domains", env.API_301_URL);
    url.searchParams.set("role", "acceptor,donor");
    url.searchParams.set("active", "1");
    url.searchParams.set("fields", "domain_name");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.WEBHOOK_SECRET}`,
        "X-Account-ID": env.ACCOUNT_ID,
      },
    });

    if (!response.ok) {
      console.error(`[Domains] API fetch failed: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as API301DomainsResponse;

    if (!data.ok || !data.domains) {
      return [];
    }

    // Filter only acceptor and donor (no reserve)
    return data.domains
      .filter((d) => d.role === "acceptor" || d.role === "donor" || !d.role)
      .map((d) => d.domain_name);
  } catch (err) {
    console.error("[Domains] API fetch error:", err);
    return [];
  }
}

/**
 * Получить домены из локальной таблицы
 */
async function getDomainsFromLocalDB(env: Env): Promise<string[]> {
  try {
    // Check if domain_list table exists
    const tableCheck = await env.DB.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='domain_list'
    `).first<{ name: string }>();

    if (!tableCheck) {
      return [];
    }

    const result = await env.DB.prepare(`
      SELECT domain_name FROM domain_list
      WHERE role IN ('acceptor', 'donor')
      AND active = 1
    `).all<{ domain_name: string }>();

    return result.results.map((r) => r.domain_name);
  } catch (err) {
    console.error("[Domains] Local DB error:", err);
    return [];
  }
}

/**
 * Получить домены которые уже проверялись (fallback)
 */
async function getKnownDomains(env: Env): Promise<string[]> {
  try {
    const result = await env.DB.prepare(`
      SELECT domain_name FROM domain_threats
      ORDER BY checked_at DESC
      LIMIT 500
    `).all<{ domain_name: string }>();

    return result.results.map((r) => r.domain_name);
  } catch (err) {
    console.error("[Domains] Known domains error:", err);
    return [];
  }
}

// ============================================================
// TRAFFIC ANOMALY DETECTION
// ============================================================

export interface TrafficAnomaly {
  domain_name: string;
  zone_id?: string;
  yesterday: number;
  today: number;
  anomaly_type: "drop_50" | "drop_90" | "zero_traffic";
}

/**
 * Обнаружить аномалии трафика
 *
 * Требует таблицу traffic_stats с данными за вчера/сегодня.
 * Эта таблица должна заполняться отдельным процессом (например, из CF GraphQL).
 */
export async function detectTrafficAnomalies(env: Env): Promise<TrafficAnomaly[]> {
  try {
    // Check if traffic_stats table exists
    const tableCheck = await env.DB.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='traffic_stats'
    `).first<{ name: string }>();

    if (!tableCheck) {
      console.log("[Anomaly] traffic_stats table not found");
      return [];
    }

    const result = await env.DB.prepare(`
      SELECT domain_name, zone_id, clicks_yesterday, clicks_today
      FROM traffic_stats
      WHERE clicks_yesterday > 0
    `).all<{
      domain_name: string;
      zone_id: string | null;
      clicks_yesterday: number;
      clicks_today: number;
    }>();

    const anomalies: TrafficAnomaly[] = [];

    for (const row of result.results) {
      const anomalyType = detectAnomalyType(row.clicks_yesterday, row.clicks_today);

      if (anomalyType) {
        anomalies.push({
          domain_name: row.domain_name,
          zone_id: row.zone_id || undefined,
          yesterday: row.clicks_yesterday,
          today: row.clicks_today,
          anomaly_type: anomalyType,
        });
      }
    }

    return anomalies;
  } catch (err) {
    console.error("[Anomaly] Detection error:", err);
    return [];
  }
}

/**
 * Определить тип аномалии
 */
function detectAnomalyType(
  yesterday: number,
  today: number
): "drop_50" | "drop_90" | "zero_traffic" | null {
  // zero_traffic: сегодня 0, вчера было >= 20
  if (today === 0 && yesterday >= 20) {
    return "zero_traffic";
  }

  // drop_90: падение более чем на 90%
  if (yesterday > 0 && today < yesterday * 0.1) {
    return "drop_90";
  }

  // drop_50: падение более чем на 50%
  if (yesterday > 0 && today < yesterday * 0.5) {
    return "drop_50";
  }

  return null;
}

// ============================================================
// DOMAIN LIST SYNC
// ============================================================

/**
 * Синхронизировать список доменов из 301.st в локальную таблицу
 */
export async function syncDomainList(env: Env): Promise<{ synced: number; error?: string }> {
  if (!env.API_301_URL) {
    return { synced: 0, error: "API_301_URL not configured" };
  }

  try {
    const url = new URL("/api/domains", env.API_301_URL);
    url.searchParams.set("role", "acceptor,donor");
    url.searchParams.set("active", "1");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.WEBHOOK_SECRET}`,
        "X-Account-ID": env.ACCOUNT_ID,
      },
    });

    if (!response.ok) {
      return { synced: 0, error: `http_${response.status}` };
    }

    const data = (await response.json()) as API301DomainsResponse;

    if (!data.ok || !data.domains) {
      return { synced: 0, error: data.error || "invalid_response" };
    }

    // Ensure domain_list table exists
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS domain_list (
        domain_name TEXT PRIMARY KEY,
        role TEXT,
        zone_id TEXT,
        active INTEGER DEFAULT 1,
        synced_at TEXT
      )
    `).run();

    // Clear and repopulate
    await env.DB.prepare(`DELETE FROM domain_list`).run();

    let synced = 0;
    for (const domain of data.domains) {
      await env.DB.prepare(`
        INSERT INTO domain_list (domain_name, role, zone_id, active, synced_at)
        VALUES (?, ?, ?, 1, datetime('now'))
      `).bind(domain.domain_name, domain.role || null, domain.zone_id || null).run();
      synced++;
    }

    return { synced };
  } catch (err) {
    return { synced: 0, error: err instanceof Error ? err.message : "sync_error" };
  }
}
