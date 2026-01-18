// src/api/domains/health.ts

/**
 * Domain Health Check Functions
 *
 * Функции для проверки и обновления статуса здоровья доменов:
 * - CF Phishing detection
 * - Traffic anomaly detection
 * - VT/CF Intel threat assessment
 */

import type { Context } from "hono";
import type { Env } from "../../types/worker";
import { requireAuth } from "../lib/auth";

// ============================================================
// TYPES
// ============================================================

export type AnomalyType = "drop_50" | "drop_90" | "zero_traffic" | null;

export interface DomainHealthStatus {
  status: "blocked" | "warning" | "healthy" | "unknown";
  blocked: boolean;
  blocked_reason: string | null;
  threats: {
    score: number | null;
    categories: string[] | null;
    reputation: number | null;
    source: string | null;
    checked_at: string | null;
  } | null;
  traffic: {
    yesterday: number;
    today: number;
    change_percent: number;
    anomaly: boolean;
  } | null;
}

// ============================================================
// CF PHISHING STATUS
// ============================================================

/**
 * Обновить статус phishing для всех доменов зоны
 *
 * Вызывается при:
 * - Создании зоны
 * - Sync zone (UI кнопка)
 * - Traffic anomaly detection
 * - Webhook от клиента
 *
 * @param env - Environment
 * @param zoneId - ID зоны в D1 (zones.id)
 * @param phishingDetected - true если CF заблокировал за phishing
 * @returns Количество обновлённых доменов
 */
export async function updateDomainsPhishingStatus(
  env: Env,
  zoneId: number,
  phishingDetected: boolean
): Promise<{ updated: number }> {
  let result;

  if (phishingDetected) {
    // Блокируем все домены зоны
    result = await env.DB301.prepare(
      `UPDATE domains
       SET blocked = 1, blocked_reason = 'phishing', updated_at = CURRENT_TIMESTAMP
       WHERE zone_id = ?`
    )
      .bind(zoneId)
      .run();
  } else {
    // Снимаем блокировку только если причина была 'phishing'
    // Не трогаем домены заблокированные по другим причинам
    result = await env.DB301.prepare(
      `UPDATE domains
       SET blocked = 0, blocked_reason = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE zone_id = ? AND blocked_reason = 'phishing'`
    )
      .bind(zoneId)
      .run();
  }

  return { updated: result.meta.changes };
}

// ============================================================
// TRAFFIC ANOMALY DETECTION
// ============================================================

/**
 * Определить тип аномалии трафика
 *
 * @param yesterday - Клики за вчера
 * @param today - Клики за сегодня
 * @returns Тип аномалии или null
 */
export function detectAnomaly(yesterday: number, today: number): AnomalyType {
  // zero_traffic: сегодня 0 кликов, вчера было >= 20
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

/**
 * Проверить нужно ли триггерить phishing check при аномалии
 *
 * @param anomaly - Тип аномалии
 * @returns true если нужно проверить phishing
 */
export function shouldCheckPhishing(anomaly: AnomalyType): boolean {
  return anomaly === "drop_90" || anomaly === "zero_traffic";
}

// ============================================================
// DOMAIN THREATS (UPSERT)
// ============================================================

/**
 * Обновить или создать запись об угрозах домена
 *
 * @param env - Environment
 * @param domainId - ID домена (domains.id)
 * @param threat - Данные об угрозе
 */
export async function upsertDomainThreat(
  env: Env,
  domainId: number,
  threat: {
    threat_score: number;
    categories: string[];
    reputation: number;
    source: "virustotal" | "cloudflare_intel";
    checked_at: string;
  }
): Promise<void> {
  await env.DB301.prepare(
    `INSERT INTO domain_threats (domain_id, threat_score, categories, reputation, source, checked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(domain_id) DO UPDATE SET
       threat_score = excluded.threat_score,
       categories = excluded.categories,
       reputation = excluded.reputation,
       source = excluded.source,
       checked_at = excluded.checked_at,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(
      domainId,
      threat.threat_score,
      JSON.stringify(threat.categories),
      threat.reputation,
      threat.source,
      threat.checked_at
    )
    .run();
}

// ============================================================
// API HANDLER: GET /domains/:id/health
// ============================================================

/**
 * GET /domains/:id/health
 * Детальная информация о здоровье домена для UI (Security Tab)
 */
export async function handleGetDomainHealth(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const domainId = parseInt(c.req.param("id"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  // Получаем домен с данными об угрозах
  const domain = await env.DB301.prepare(
    `SELECT d.id, d.domain_name, d.blocked, d.blocked_reason, d.zone_id,
            t.threat_score, t.categories, t.reputation, t.source, t.checked_at
     FROM domains d
     LEFT JOIN domain_threats t ON d.id = t.domain_id
     WHERE d.id = ? AND d.account_id = ?`
  )
    .bind(domainId, accountId)
    .first<{
      id: number;
      domain_name: string;
      blocked: number;
      blocked_reason: string | null;
      zone_id: number | null;
      threat_score: number | null;
      categories: string | null;
      reputation: number | null;
      source: string | null;
      checked_at: string | null;
    }>();

  if (!domain) {
    return c.json({ ok: false, error: "domain_not_found" }, 404);
  }

  // Получаем статистику трафика (clicks_yesterday, clicks_today из redirect_rules)
  const traffic = await env.DB301.prepare(
    `SELECT
       COALESCE(SUM(clicks_yesterday), 0) as yesterday,
       COALESCE(SUM(clicks_today), 0) as today
     FROM redirect_rules
     WHERE domain_id = ? AND enabled = 1`
  )
    .bind(domainId)
    .first<{ yesterday: number; today: number }>();

  const yesterday = traffic?.yesterday ?? 0;
  const today = traffic?.today ?? 0;
  const changePercent = yesterday > 0 ? Math.round(((today - yesterday) / yesterday) * 100) : 0;
  const anomaly = detectAnomaly(yesterday, today);

  // Определяем общий статус
  let status: DomainHealthStatus["status"] = "unknown";
  if (domain.blocked === 1) {
    status = "blocked";
  } else if (domain.threat_score && domain.threat_score > 0) {
    status = "warning";
  } else if (anomaly === "drop_90" || anomaly === "zero_traffic") {
    status = "warning";
  } else if (domain.threat_score !== null || traffic) {
    status = "healthy";
  }

  // Парсим categories из JSON
  let categories: string[] | null = null;
  if (domain.categories) {
    try {
      categories = JSON.parse(domain.categories);
    } catch {
      categories = null;
    }
  }

  const health: DomainHealthStatus = {
    status,
    blocked: domain.blocked === 1,
    blocked_reason: domain.blocked_reason,
    threats:
      domain.threat_score !== null
        ? {
            score: domain.threat_score,
            categories,
            reputation: domain.reputation,
            source: domain.source,
            checked_at: domain.checked_at,
          }
        : null,
    traffic: {
      yesterday,
      today,
      change_percent: changePercent,
      anomaly: anomaly !== null,
    },
  };

  return c.json({ ok: true, health });
}

// ============================================================
// HEALTH STATUS FOR DOMAIN LIST
// ============================================================

/**
 * Получить краткий health статус для списка доменов
 * Используется в GET /domains для колонки светофора
 */
export function computeDomainHealthStatus(domain: {
  blocked: number;
  blocked_reason: string | null;
  threat_score: number | null;
  clicks_yesterday?: number;
  clicks_today?: number;
}): "blocked" | "warning" | "healthy" | "unknown" {
  // Blocked = красный
  if (domain.blocked === 1) {
    return "blocked";
  }

  // Warning = жёлтый (есть угрозы или аномалия трафика)
  if (domain.threat_score && domain.threat_score > 0) {
    return "warning";
  }

  // Проверяем аномалию трафика если есть данные
  if (domain.clicks_yesterday !== undefined && domain.clicks_today !== undefined) {
    const anomaly = detectAnomaly(domain.clicks_yesterday, domain.clicks_today);
    if (anomaly === "drop_90" || anomaly === "zero_traffic") {
      return "warning";
    }
  }

  // Если есть данные о threat_score (даже 0) - домен проверен
  if (domain.threat_score !== null) {
    return "healthy";
  }

  return "unknown";
}
