// src/api/jobs/tds-stats.ts

/**
 * TDS Stats Cron Job
 *
 * Ежечасный сбор статистики TDS из Client D1 (stats_hourly).
 * Данные → DB301.tds_stats для отображения в UI.
 *
 * Алгоритм:
 * 1. Получить deployed TDS configs (client_worker_configs WHERE worker_type='tds' AND deployed=1)
 * 2. Для каждого клиента:
 *    a. Найти CF-ключ → decrypt → cfToken + cfAccountId
 *    b. SELECT stats_hourly через CF D1 API
 *    c. UPSERT в DB301.tds_stats
 *    d. DELETE старых записей (>7 дней) из Client D1
 * 3. Вернуть результат
 */

import type { Env } from "../types/worker";
import { getDecryptedKey } from "../integrations/keys/storage";
import { executeD1Query } from "../integrations/providers/cloudflare/d1";

// ============================================================
// TYPES
// ============================================================

interface TdsClientConfig {
  id: number;
  account_id: number;
  d1_database_id: string;
}

interface StatsHourlyRow {
  domain_name: string;
  rule_id: number | null;
  hour: string;
  hits: number;
  redirects: number;
  blocks: number;
  passes: number;
  by_country: string | null;
  by_device: string | null;
}

export interface TdsStatsResult {
  clients_processed: number;
  clients_failed: number;
  rows_collected: number;
  rows_cleaned: number;
  errors: string[];
}

// ============================================================
// MAIN
// ============================================================

/**
 * Собрать TDS-статистику со всех клиентских D1
 */
export async function updateTdsStats(env: Env): Promise<TdsStatsResult> {
  const result: TdsStatsResult = {
    clients_processed: 0,
    clients_failed: 0,
    rows_collected: 0,
    rows_cleaned: 0,
    errors: [],
  };

  // 1. Получить deployed TDS configs
  const configs = await env.DB301.prepare(`
    SELECT c.id, c.account_id, c.d1_database_id
    FROM client_worker_configs c
    WHERE c.worker_type = 'tds'
      AND c.deployed = 1
      AND c.d1_database_id IS NOT NULL
  `).all<TdsClientConfig>();

  if (!configs.results || configs.results.length === 0) {
    return result;
  }

  // 2. Обработать каждого клиента
  for (const config of configs.results) {
    try {
      const clientResult = await processClientStats(env, config);
      result.clients_processed++;
      result.rows_collected += clientResult.rows_collected;
      result.rows_cleaned += clientResult.rows_cleaned;
    } catch (e) {
      result.clients_failed++;
      result.errors.push(`Config ${config.id} (account ${config.account_id}): ${e}`);
    }
  }

  return result;
}

// ============================================================
// CLIENT PROCESSING
// ============================================================

interface ClientStatsResult {
  rows_collected: number;
  rows_cleaned: number;
}

/**
 * Обработать статистику одного клиента
 */
async function processClientStats(
  env: Env,
  config: TdsClientConfig,
): Promise<ClientStatsResult> {
  const result: ClientStatsResult = {
    rows_collected: 0,
    rows_cleaned: 0,
  };

  // 1. Найти CF-ключ для этого аккаунта
  const cfKey = await env.DB301.prepare(`
    SELECT id, external_account_id
    FROM account_keys
    WHERE account_id = ? AND provider = 'cloudflare' AND status = 'active'
    LIMIT 1
  `).bind(config.account_id).first<{ id: number; external_account_id: string | null }>();

  if (!cfKey || !cfKey.external_account_id) {
    throw new Error("no_active_cf_key");
  }

  // 2. Расшифровать токен
  const decrypted = await getDecryptedKey(env, cfKey.id);
  if (!decrypted) {
    throw new Error("key_decrypt_failed");
  }

  const cfToken = decrypted.secrets.token;
  const cfAccountId = cfKey.external_account_id;

  // 3. SELECT stats_hourly из Client D1
  const selectResult = await executeD1Query(
    cfAccountId,
    config.d1_database_id,
    `SELECT domain_name, rule_id, hour, hits, redirects, blocks, passes, by_country, by_device
     FROM stats_hourly
     ORDER BY hour ASC`,
    cfToken,
  );

  if (!selectResult.ok) {
    throw new Error(`d1_select_failed: ${selectResult.error}`);
  }

  const rows = (selectResult.results?.[0]?.results || []) as unknown as StatsHourlyRow[];

  if (rows.length === 0) {
    return result;
  }

  // 4. UPSERT в DB301.tds_stats
  for (const row of rows) {
    // Получаем существующую запись для JSON merge
    const existing = await env.DB301.prepare(`
      SELECT by_country, by_device FROM tds_stats
      WHERE account_id = ? AND domain_name = ? AND rule_id IS ? AND hour = ?
    `).bind(config.account_id, row.domain_name, row.rule_id, row.hour)
      .first<{ by_country: string | null; by_device: string | null }>();

    const mergedCountry = mergeJsonCounters(existing?.by_country, row.by_country);
    const mergedDevice = mergeJsonCounters(existing?.by_device, row.by_device);

    await env.DB301.prepare(`
      INSERT INTO tds_stats (account_id, domain_name, rule_id, hour, hits, redirects, blocks, passes, by_country, by_device)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, domain_name, rule_id, hour) DO UPDATE SET
        hits = hits + excluded.hits,
        redirects = redirects + excluded.redirects,
        blocks = blocks + excluded.blocks,
        passes = passes + excluded.passes,
        by_country = ?,
        by_device = ?,
        collected_at = CURRENT_TIMESTAMP
    `).bind(
      config.account_id,
      row.domain_name,
      row.rule_id,
      row.hour,
      row.hits || 0,
      row.redirects || 0,
      row.blocks || 0,
      row.passes || 0,
      mergedCountry,
      mergedDevice,
      mergedCountry,
      mergedDevice,
    ).run();

    result.rows_collected++;
  }

  // 5. DELETE старых записей из Client D1 (>7 дней)
  const deleteResult = await executeD1Query(
    cfAccountId,
    config.d1_database_id,
    `DELETE FROM stats_hourly WHERE hour < datetime('now', '-7 days')`,
    cfToken,
  );

  if (deleteResult.ok && deleteResult.results?.[0]?.meta?.changes) {
    result.rows_cleaned = deleteResult.results[0].meta.changes;
  }

  return result;
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Merge JSON counter objects: {"RU":10,"US":5} + {"RU":3,"DE":1} → {"RU":13,"US":5,"DE":1}
 */
function mergeJsonCounters(
  existingJson: string | null | undefined,
  incomingJson: string | null | undefined,
): string | null {
  if (!existingJson && !incomingJson) return null;
  if (!existingJson) return incomingJson || null;
  if (!incomingJson) return existingJson;

  try {
    const existing: Record<string, number> = JSON.parse(existingJson);
    const incoming: Record<string, number> = JSON.parse(incomingJson);

    for (const [key, value] of Object.entries(incoming)) {
      existing[key] = (existing[key] || 0) + value;
    }

    return JSON.stringify(existing);
  } catch {
    // Если парсинг не удался — вернуть incoming (свежие данные)
    return incomingJson;
  }
}
