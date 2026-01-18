// src/api/integrations/providers/cloudflare/d1-sync.ts

/**
 * D1 Sync Module
 *
 * Push data from 301.st to client's D1 database.
 * Used when client updates TDS rules or domain configs.
 *
 * Push Model:
 * - 301.st = master (stores all data)
 * - Client D1 = slave/cache (receives synced data)
 * - Client Worker reads from local D1 (no API calls during request)
 */

import { executeD1Query } from "./d1";
import { getDecryptedKey } from "../../keys/storage";
import type { Env } from "../../../types/worker";

// ============================================================
// TYPES
// ============================================================

export interface ClientSyncInfo {
  cfAccountId: string;
  cfToken: string;
  clientD1Id: string;
  clientKvId?: string;
}

// ============================================================
// HELPER: Get Client Sync Info
// ============================================================

/**
 * Get client sync info from account_keys
 * Returns CF account ID, token, and client D1/KV IDs
 */
export async function getClientSyncInfo(
  env: Env,
  keyId: number
): Promise<{ ok: true; info: ClientSyncInfo } | { ok: false; error: string }> {
  // Get key with client_env
  const keyRow = await env.DB301.prepare(
    `SELECT external_account_id, client_env FROM account_keys WHERE id = ? AND status = 'active'`
  ).bind(keyId).first<{
    external_account_id: string;
    client_env: string | null;
  }>();

  if (!keyRow) {
    return { ok: false, error: "key_not_found" };
  }

  if (!keyRow.client_env) {
    return { ok: false, error: "client_env_not_configured" };
  }

  // Parse client_env
  let clientEnv: {
    d1_id?: string;
    kv_id?: string;
    health_worker?: boolean;
    tds_worker?: boolean;
  };

  try {
    clientEnv = JSON.parse(keyRow.client_env);
  } catch {
    return { ok: false, error: "invalid_client_env" };
  }

  if (!clientEnv.d1_id) {
    return { ok: false, error: "client_d1_not_configured" };
  }

  // Get decrypted token
  const keyData = await getDecryptedKey(env, keyId);
  if (!keyData) {
    return { ok: false, error: "key_decryption_failed" };
  }

  return {
    ok: true,
    info: {
      cfAccountId: keyRow.external_account_id,
      cfToken: keyData.secrets.token,
      clientD1Id: clientEnv.d1_id,
      clientKvId: clientEnv.kv_id,
    },
  };
}

export interface DomainListItem {
  domain_name: string;
  role?: string;
  zone_id?: string;
  active: boolean;
}

export interface TrafficStats {
  domain_name: string;
  zone_id?: string;
  clicks_yesterday: number;
  clicks_today: number;
}

export interface TDSRule {
  id: number;
  domain_name: string;
  priority: number;
  conditions: Record<string, unknown>;
  action: "redirect" | "block" | "pass";
  action_url?: string;
  status_code: number;
  active: boolean;
}

export interface DomainConfig {
  domain_name: string;
  tds_enabled: boolean;
  default_action: "redirect" | "block" | "pass";
  default_url?: string;
  smartshield_enabled: boolean;
  bot_action: "block" | "pass" | "redirect";
  bot_redirect_url?: string;
}

// ============================================================
// SYNC FUNCTIONS
// ============================================================

/**
 * Sync domain list to client D1
 */
export async function syncDomainList(
  cfAccountId: string,
  databaseId: string,
  token: string,
  domains: DomainListItem[]
): Promise<{ ok: boolean; synced: number; error?: string }> {
  if (domains.length === 0) {
    return { ok: true, synced: 0 };
  }

  // Build UPSERT SQL
  const values = domains.map(d =>
    `('${escapeSql(d.domain_name)}', '${escapeSql(d.role || "")}', '${escapeSql(d.zone_id || "")}', ${d.active ? 1 : 0}, datetime('now'))`
  ).join(",\n");

  const sql = `
    INSERT OR REPLACE INTO domain_list (domain_name, role, zone_id, active, synced_at)
    VALUES ${values};
  `;

  const result = await executeD1Query(cfAccountId, databaseId, sql, token);

  if (!result.ok) {
    return { ok: false, synced: 0, error: result.error };
  }

  return { ok: true, synced: domains.length };
}

/**
 * Sync traffic stats to client D1
 */
export async function syncTrafficStats(
  cfAccountId: string,
  databaseId: string,
  token: string,
  stats: TrafficStats[]
): Promise<{ ok: boolean; synced: number; error?: string }> {
  if (stats.length === 0) {
    return { ok: true, synced: 0 };
  }

  const values = stats.map(s =>
    `('${escapeSql(s.domain_name)}', '${escapeSql(s.zone_id || "")}', ${s.clicks_yesterday}, ${s.clicks_today}, datetime('now'))`
  ).join(",\n");

  const sql = `
    INSERT OR REPLACE INTO traffic_stats (domain_name, zone_id, clicks_yesterday, clicks_today, updated_at)
    VALUES ${values};
  `;

  const result = await executeD1Query(cfAccountId, databaseId, sql, token);

  if (!result.ok) {
    return { ok: false, synced: 0, error: result.error };
  }

  return { ok: true, synced: stats.length };
}

/**
 * Sync TDS rules to client D1
 */
export async function syncTDSRules(
  cfAccountId: string,
  databaseId: string,
  token: string,
  rules: TDSRule[]
): Promise<{ ok: boolean; synced: number; error?: string }> {
  // First, clear existing rules for domains in the update
  const domainNames = [...new Set(rules.map(r => r.domain_name))];

  if (domainNames.length > 0) {
    const deleteCondition = domainNames.map(d => `'${escapeSql(d)}'`).join(",");
    const deleteSql = `DELETE FROM tds_rules WHERE domain_name IN (${deleteCondition});`;

    const deleteResult = await executeD1Query(cfAccountId, databaseId, deleteSql, token);
    if (!deleteResult.ok) {
      return { ok: false, synced: 0, error: `Delete failed: ${deleteResult.error}` };
    }
  }

  if (rules.length === 0) {
    return { ok: true, synced: 0 };
  }

  // Insert new rules
  const values = rules.map(r =>
    `(${r.id}, '${escapeSql(r.domain_name)}', ${r.priority}, '${escapeSql(JSON.stringify(r.conditions))}', '${r.action}', ${r.action_url ? `'${escapeSql(r.action_url)}'` : "NULL"}, ${r.status_code}, ${r.active ? 1 : 0}, datetime('now'))`
  ).join(",\n");

  const sql = `
    INSERT INTO tds_rules (id, domain_name, priority, conditions, action, action_url, status_code, active, synced_at)
    VALUES ${values};
  `;

  const result = await executeD1Query(cfAccountId, databaseId, sql, token);

  if (!result.ok) {
    return { ok: false, synced: 0, error: result.error };
  }

  return { ok: true, synced: rules.length };
}

/**
 * Sync domain config to client D1
 */
export async function syncDomainConfig(
  cfAccountId: string,
  databaseId: string,
  token: string,
  configs: DomainConfig[]
): Promise<{ ok: boolean; synced: number; error?: string }> {
  if (configs.length === 0) {
    return { ok: true, synced: 0 };
  }

  const values = configs.map(c =>
    `('${escapeSql(c.domain_name)}', ${c.tds_enabled ? 1 : 0}, '${c.default_action}', ${c.default_url ? `'${escapeSql(c.default_url)}'` : "NULL"}, ${c.smartshield_enabled ? 1 : 0}, '${c.bot_action}', ${c.bot_redirect_url ? `'${escapeSql(c.bot_redirect_url)}'` : "NULL"}, datetime('now'))`
  ).join(",\n");

  const sql = `
    INSERT OR REPLACE INTO domain_config (domain_name, tds_enabled, default_action, default_url, smartshield_enabled, bot_action, bot_redirect_url, synced_at)
    VALUES ${values};
  `;

  const result = await executeD1Query(cfAccountId, databaseId, sql, token);

  if (!result.ok) {
    return { ok: false, synced: 0, error: result.error };
  }

  return { ok: true, synced: configs.length };
}

/**
 * Update sync status timestamp
 */
export async function updateSyncStatus(
  cfAccountId: string,
  databaseId: string,
  token: string,
  key: string = "last_sync"
): Promise<{ ok: boolean; error?: string }> {
  const sql = `
    INSERT OR REPLACE INTO sync_status (key, value, updated_at)
    VALUES ('${escapeSql(key)}', datetime('now'), datetime('now'));
  `;

  const result = await executeD1Query(cfAccountId, databaseId, sql, token);

  return { ok: result.ok, error: result.error };
}

// ============================================================
// BATCH SYNC
// ============================================================

export interface BatchSyncData {
  domains?: DomainListItem[];
  traffic?: TrafficStats[];
  rules?: TDSRule[];
  configs?: DomainConfig[];
}

export interface BatchSyncResult {
  ok: boolean;
  domains_synced: number;
  traffic_synced: number;
  rules_synced: number;
  configs_synced: number;
  errors: string[];
}

/**
 * Batch sync all data to client D1
 */
export async function batchSyncToClient(
  cfAccountId: string,
  databaseId: string,
  token: string,
  data: BatchSyncData
): Promise<BatchSyncResult> {
  const result: BatchSyncResult = {
    ok: true,
    domains_synced: 0,
    traffic_synced: 0,
    rules_synced: 0,
    configs_synced: 0,
    errors: [],
  };

  // Sync domains
  if (data.domains && data.domains.length > 0) {
    const domainsResult = await syncDomainList(cfAccountId, databaseId, token, data.domains);
    if (domainsResult.ok) {
      result.domains_synced = domainsResult.synced;
    } else {
      result.errors.push(`domains: ${domainsResult.error}`);
    }
  }

  // Sync traffic
  if (data.traffic && data.traffic.length > 0) {
    const trafficResult = await syncTrafficStats(cfAccountId, databaseId, token, data.traffic);
    if (trafficResult.ok) {
      result.traffic_synced = trafficResult.synced;
    } else {
      result.errors.push(`traffic: ${trafficResult.error}`);
    }
  }

  // Sync rules
  if (data.rules && data.rules.length > 0) {
    const rulesResult = await syncTDSRules(cfAccountId, databaseId, token, data.rules);
    if (rulesResult.ok) {
      result.rules_synced = rulesResult.synced;
    } else {
      result.errors.push(`rules: ${rulesResult.error}`);
    }
  }

  // Sync configs
  if (data.configs && data.configs.length > 0) {
    const configsResult = await syncDomainConfig(cfAccountId, databaseId, token, data.configs);
    if (configsResult.ok) {
      result.configs_synced = configsResult.synced;
    } else {
      result.errors.push(`configs: ${configsResult.error}`);
    }
  }

  // Update sync status
  await updateSyncStatus(cfAccountId, databaseId, token);

  result.ok = result.errors.length === 0;

  return result;
}

// ============================================================
// HIGH-LEVEL SYNC FUNCTIONS
// ============================================================

/**
 * Sync single domain to client D1
 * Call after domain create/update
 *
 * @param env - Worker environment
 * @param domainId - Domain ID in 301.st D1
 */
export async function syncDomainToClient(
  env: Env,
  domainId: number
): Promise<{ ok: boolean; error?: string }> {
  // 1. Get domain with zone and key info
  const domain = await env.DB301.prepare(`
    SELECT d.domain_name, d.role, d.blocked, z.cf_zone_id, z.key_id
    FROM domains d
    JOIN zones z ON d.zone_id = z.id
    WHERE d.id = ?
  `).bind(domainId).first<{
    domain_name: string;
    role: string | null;
    blocked: number;
    cf_zone_id: string;
    key_id: number;
  }>();

  if (!domain) {
    // Domain not found - might be already deleted
    return { ok: true };
  }

  // 2. Get client sync info
  const syncInfo = await getClientSyncInfo(env, domain.key_id);
  if (!syncInfo.ok) {
    // Client env not configured - skip sync silently
    if (syncInfo.error === "client_d1_not_configured") {
      return { ok: true };
    }
    return { ok: false, error: syncInfo.error };
  }

  const { cfAccountId, cfToken, clientD1Id } = syncInfo.info;

  // 3. Upsert domain
  const result = await syncDomainList(cfAccountId, clientD1Id, cfToken, [{
    domain_name: domain.domain_name,
    role: domain.role || undefined,
    zone_id: domain.cf_zone_id,
    active: domain.blocked === 0,
  }]);
  return { ok: result.ok, error: result.error };
}

/**
 * Delete domain from client D1
 * Call before domain deletion from 301.st D1
 *
 * @param env - Worker environment
 * @param keyId - Key ID for getting client sync info
 * @param domainName - Domain name to delete
 */
export async function deleteDomainFromClient(
  env: Env,
  keyId: number,
  domainName: string
): Promise<{ ok: boolean; error?: string }> {
  // 1. Get client sync info
  const syncInfo = await getClientSyncInfo(env, keyId);
  if (!syncInfo.ok) {
    // Client env not configured - skip sync silently
    if (syncInfo.error === "client_d1_not_configured") {
      return { ok: true };
    }
    return { ok: false, error: syncInfo.error };
  }

  const { cfAccountId, cfToken, clientD1Id } = syncInfo.info;

  // 2. Delete from client D1
  const sql = `DELETE FROM domain_list WHERE domain_name = '${escapeSql(domainName)}'`;
  const result = await executeD1Query(cfAccountId, clientD1Id, sql, cfToken);
  return { ok: result.ok, error: result.error };
}

/**
 * Sync all domains for account to client D1
 * Call after bulk operations or manual sync
 */
export async function syncAllDomainsToClient(
  env: Env,
  accountId: number,
  keyId: number
): Promise<{ ok: boolean; synced: number; error?: string }> {
  // 1. Get client sync info
  const syncInfo = await getClientSyncInfo(env, keyId);
  if (!syncInfo.ok) {
    return { ok: false, synced: 0, error: syncInfo.error };
  }

  const { cfAccountId, cfToken, clientD1Id } = syncInfo.info;

  // 2. Get all domains for this account
  const domainsResult = await env.DB301.prepare(`
    SELECT d.domain_name, d.role, z.cf_zone_id as zone_id,
           CASE WHEN d.blocked = 0 THEN 1 ELSE 0 END as active
    FROM domains d
    JOIN zones z ON d.zone_id = z.id
    WHERE d.account_id = ? AND z.key_id = ?
  `).bind(accountId, keyId).all<{
    domain_name: string;
    role: string | null;
    zone_id: string;
    active: number;
  }>();

  if (!domainsResult.results || domainsResult.results.length === 0) {
    return { ok: true, synced: 0 };
  }

  // 3. Sync all
  const items: DomainListItem[] = domainsResult.results.map(d => ({
    domain_name: d.domain_name,
    role: d.role || undefined,
    zone_id: d.zone_id,
    active: d.active === 1,
  }));

  const result = await syncDomainList(cfAccountId, clientD1Id, cfToken, items);
  return { ok: result.ok, synced: result.synced, error: result.error };
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Escape SQL string to prevent injection
 */
function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}
