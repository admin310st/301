// src/api/jobs/redirect-stats.ts

/**
 * Redirect Stats Cron Job
 *
 * Ежедневный сбор статистики редиректов из CF GraphQL Analytics API.
 * Free Plan: 3 дня retention — job должен работать ежедневно.
 *
 * Алгоритм:
 * 1. Получить все зоны с активными редиректами
 * 2. Для каждой зоны запросить CF GraphQL API (3xx по host)
 * 3. Обновить счётчики в redirect_rules
 */

import type { Env } from "../types/worker";
import { getDecryptedKey } from "../integrations/keys/storage";
import { fetchRedirectStats, getYesterdayDate, getTodayDate } from "../redirects/analytics";

// ============================================================
// TYPES
// ============================================================

interface ZoneWithKey {
  id: number;
  cf_zone_id: string;
  key_id: number;
  account_id: number;
}

interface UpdateResult {
  zones_processed: number;
  zones_failed: number;
  rules_updated: number;
  errors: string[];
}

// ============================================================
// MAIN
// ============================================================

/**
 * Обновить статистику редиректов для всех зон
 */
export async function updateRedirectStats(env: Env): Promise<UpdateResult> {
  const result: UpdateResult = {
    zones_processed: 0,
    zones_failed: 0,
    rules_updated: 0,
    errors: [],
  };

  const yesterday = getYesterdayDate();
  const today = getTodayDate();

  // 1. Получить все зоны с активными редиректами
  const zones = await env.DB301.prepare(`
    SELECT DISTINCT z.id, z.cf_zone_id, z.key_id, z.account_id
    FROM zones z
    JOIN redirect_rules r ON r.zone_id = z.id
    WHERE r.enabled = 1 AND z.cf_zone_id IS NOT NULL AND z.key_id IS NOT NULL
  `).all<ZoneWithKey>();

  if (!zones.results || zones.results.length === 0) {
    return result;
  }

  // 2. Обработать каждую зону
  for (const zone of zones.results) {
    try {
      const updated = await processZoneStats(env, zone, yesterday, today);
      result.zones_processed++;
      result.rules_updated += updated;
    } catch (e) {
      result.zones_failed++;
      result.errors.push(`Zone ${zone.id}: ${e}`);
    }
  }

  return result;
}

/**
 * Обработать статистику одной зоны
 */
async function processZoneStats(
  env: Env,
  zone: ZoneWithKey,
  yesterday: string,
  today: string
): Promise<number> {
  // 1. Получить токен
  const keyData = await getDecryptedKey(env, zone.key_id);
  if (!keyData) {
    throw new Error("key_not_found");
  }

  // 2. Запросить статистику из CF
  const stats = await fetchRedirectStats(zone.cf_zone_id, keyData.secrets.token, yesterday);

  if (stats.length === 0) {
    // Нет данных — просто ротируем счётчики
    await rotateCounters(env, zone.id, today);
    return 0;
  }

  // 3. Получить домены зоны для маппинга host → domain_id
  const domains = await env.DB301.prepare(`
    SELECT id, domain_name FROM domains WHERE zone_id = ?
  `).all<{ id: number; domain_name: string }>();

  const domainMap = new Map<string, number>();
  for (const d of domains.results || []) {
    domainMap.set(d.domain_name.toLowerCase(), d.id);
  }

  // 4. Обновить счётчики
  let updatedCount = 0;

  for (const stat of stats) {
    const domainId = domainMap.get(stat.host.toLowerCase());
    if (!domainId) continue;

    // Обновить все правила этого домена
    const updateResult = await env.DB301.prepare(`
      UPDATE redirect_rules
      SET
        clicks_total = clicks_total + ?,
        clicks_yesterday = clicks_today,
        clicks_today = 0,
        last_counted_date = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE domain_id = ? AND zone_id = ? AND enabled = 1
        AND (last_counted_date IS NULL OR last_counted_date != ?)
    `).bind(stat.count, today, domainId, zone.id, today).run();

    updatedCount += updateResult.meta?.changes || 0;
  }

  // 5. Ротировать счётчики для доменов без статистики
  await rotateCounters(env, zone.id, today);

  return updatedCount;
}

/**
 * Ротация счётчиков: yesterday = today, today = 0
 * Для правил которые не получили данных из CF (0 переходов)
 */
async function rotateCounters(env: Env, zoneId: number, today: string): Promise<void> {
  await env.DB301.prepare(`
    UPDATE redirect_rules
    SET
      clicks_yesterday = clicks_today,
      clicks_today = 0,
      last_counted_date = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE zone_id = ? AND enabled = 1
      AND (last_counted_date IS NULL OR last_counted_date != ?)
  `).bind(today, zoneId, today).run();
}
