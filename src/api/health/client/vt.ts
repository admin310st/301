/**
 * VirusTotal API Client
 *
 * Rate Limits (Free Tier):
 * - 4 requests/min (15 sec between requests)
 * - 500 requests/day
 *
 * Обрабатываем очередь threat_check_queue с учётом лимитов.
 */

import type { Env, DomainThreat } from "./index";

// ============================================================
// CONSTANTS
// ============================================================

const VT_API_BASE = "https://www.virustotal.com/api/v3";
const VT_RATE_LIMIT_DELAY = 15500; // 15.5 sec between requests (safe margin for 4/min)
const VT_BATCH_SIZE = 4; // Process 4 domains per run (1 minute worth)
const VT_MAX_PER_RUN = 20; // Max domains per single run (5 minutes worth)

// ============================================================
// TYPES
// ============================================================

interface VTDomainResponse {
  data: {
    id: string;
    type: string;
    attributes: {
      last_analysis_stats: {
        malicious: number;
        suspicious: number;
        harmless: number;
        undetected: number;
        timeout: number;
      };
      categories: Record<string, string>;
      reputation: number;
      last_analysis_date?: number;
    };
  };
}

export interface VTProcessResult {
  processed: number;
  errors: number;
  threats: DomainThreat[];
  skipped: number;
}

// ============================================================
// VT API
// ============================================================

/**
 * Запрос информации о домене из VT
 */
async function fetchVTDomain(
  domain: string,
  apiKey: string
): Promise<{ ok: boolean; data?: VTDomainResponse; error?: string }> {
  try {
    const response = await fetch(`${VT_API_BASE}/domains/${domain}`, {
      method: "GET",
      headers: {
        "x-apikey": apiKey,
        Accept: "application/json",
      },
    });

    if (response.status === 429) {
      return { ok: false, error: "rate_limit" };
    }

    if (response.status === 404) {
      return { ok: false, error: "not_found" };
    }

    if (!response.ok) {
      return { ok: false, error: `http_${response.status}` };
    }

    const data = (await response.json()) as VTDomainResponse;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network_error" };
  }
}

/**
 * Парсинг ответа VT в наш формат
 */
function parseVTResponse(domain: string, data: VTDomainResponse): DomainThreat {
  const stats = data.data.attributes.last_analysis_stats;
  const categories = Object.values(data.data.attributes.categories || {});

  return {
    domain_name: domain,
    threat_score: stats.malicious + stats.suspicious,
    categories: categories,
    reputation: data.data.attributes.reputation,
    source: "virustotal",
    checked_at: new Date().toISOString(),
  };
}

// ============================================================
// QUEUE MANAGEMENT
// ============================================================

/**
 * Добавить домены в очередь на проверку
 */
export async function addDomainsToQueue(
  env: Env,
  domains: string[],
  priority: number = 0,
  source: string = "virustotal"
): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;

  for (const domain of domains) {
    try {
      // UPSERT: обновляем priority если домен уже есть с меньшим приоритетом
      await env.DB.prepare(`
        INSERT INTO threat_check_queue (domain_name, priority, source, added_at, status)
        VALUES (?, ?, ?, datetime('now'), 'pending')
        ON CONFLICT(domain_name) DO UPDATE SET
          priority = MAX(excluded.priority, threat_check_queue.priority),
          status = CASE
            WHEN threat_check_queue.status = 'done' THEN 'pending'
            ELSE threat_check_queue.status
          END,
          added_at = CASE
            WHEN threat_check_queue.status = 'done' THEN datetime('now')
            ELSE threat_check_queue.added_at
          END
      `).bind(domain, priority, source).run();
      added++;
    } catch (err) {
      console.error(`[VT] Failed to add ${domain} to queue:`, err);
      skipped++;
    }
  }

  return { added, skipped };
}

/**
 * Обработать очередь VT с учётом rate limits
 */
export async function processVTQueue(env: Env): Promise<VTProcessResult> {
  const result: VTProcessResult = {
    processed: 0,
    errors: 0,
    threats: [],
    skipped: 0,
  };

  // Получаем домены из очереди (priority DESC, added_at ASC)
  const queue = await env.DB.prepare(`
    SELECT domain_name, priority, source
    FROM threat_check_queue
    WHERE status = 'pending'
    ORDER BY priority DESC, added_at ASC
    LIMIT ?
  `).bind(VT_MAX_PER_RUN).all<{
    domain_name: string;
    priority: number;
    source: string;
  }>();

  if (queue.results.length === 0) {
    console.log("[VT] Queue is empty");
    return result;
  }

  console.log(`[VT] Processing ${queue.results.length} domains from queue`);

  for (const item of queue.results) {
    // Mark as processing
    await env.DB.prepare(`
      UPDATE threat_check_queue SET status = 'processing' WHERE domain_name = ?
    `).bind(item.domain_name).run();

    // Fetch from VT
    const vtResult = await fetchVTDomain(item.domain_name, env.VT_API_KEY);

    if (vtResult.ok && vtResult.data) {
      // Parse and save
      const threat = parseVTResponse(item.domain_name, vtResult.data);
      result.threats.push(threat);

      // Save to domain_threats
      await saveDomainThreat(env, threat);

      // Mark as done
      await env.DB.prepare(`
        UPDATE threat_check_queue SET status = 'done' WHERE domain_name = ?
      `).bind(item.domain_name).run();

      result.processed++;
    } else if (vtResult.error === "rate_limit") {
      // Rate limit hit, stop processing
      console.warn("[VT] Rate limit hit, stopping");
      await env.DB.prepare(`
        UPDATE threat_check_queue SET status = 'pending' WHERE domain_name = ?
      `).bind(item.domain_name).run();
      break;
    } else if (vtResult.error === "not_found") {
      // Domain not in VT, mark as done with zero score
      const threat: DomainThreat = {
        domain_name: item.domain_name,
        threat_score: 0,
        categories: [],
        reputation: 0,
        source: "virustotal",
        checked_at: new Date().toISOString(),
      };
      result.threats.push(threat);
      await saveDomainThreat(env, threat);

      await env.DB.prepare(`
        UPDATE threat_check_queue SET status = 'done' WHERE domain_name = ?
      `).bind(item.domain_name).run();

      result.processed++;
    } else {
      // Other error
      console.error(`[VT] Error checking ${item.domain_name}: ${vtResult.error}`);
      await env.DB.prepare(`
        UPDATE threat_check_queue SET status = 'error' WHERE domain_name = ?
      `).bind(item.domain_name).run();
      result.errors++;
    }

    // Rate limit delay (except for last item)
    if (result.processed < queue.results.length - 1) {
      await sleep(VT_RATE_LIMIT_DELAY);
    }
  }

  return result;
}

/**
 * Сохранить результат проверки в domain_threats
 */
async function saveDomainThreat(env: Env, threat: DomainThreat): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO domain_threats (domain_name, threat_score, categories, reputation, source, checked_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(domain_name) DO UPDATE SET
      threat_score = excluded.threat_score,
      categories = excluded.categories,
      reputation = excluded.reputation,
      source = excluded.source,
      checked_at = excluded.checked_at,
      updated_at = datetime('now')
  `).bind(
    threat.domain_name,
    threat.threat_score,
    JSON.stringify(threat.categories),
    threat.reputation,
    threat.source,
    threat.checked_at
  ).run();
}

/**
 * Очистить обработанные записи старше N дней
 */
export async function cleanupQueue(env: Env, daysOld: number = 7): Promise<number> {
  const result = await env.DB.prepare(`
    DELETE FROM threat_check_queue
    WHERE status = 'done'
    AND added_at < datetime('now', '-' || ? || ' days')
  `).bind(daysOld).run();

  return result.meta.changes;
}

// ============================================================
// HELPERS
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
