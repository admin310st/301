/**
 * 301 Client Worker
 *
 * Выполняется на CF аккаунте клиента (автономно).
 *
 * Функции:
 * - VT Check: проверка репутации доменов через VirusTotal
 * - CF Phishing: проверка meta.phishing_detected
 * - Webhook: отправка результатов в 301.st (push model)
 *
 * Rate Limits (VT Free Tier):
 * - 4 requests/min
 * - 500 requests/day
 */

import { processVTQueue, addDomainsToQueue } from "./vt";
import { checkZonePhishing } from "./phishing";
import { sendHealthWebhook, markThreatsSynced } from "./webhook";
import { getActiveDomains, detectTrafficAnomalies } from "./domains";

// ============================================================
// TYPES
// ============================================================

export interface Env {
  // D1 Database
  DB: D1Database;

  // Secrets
  VT_API_KEY: string;
  JWT_TOKEN: string;        // JWT для webhook → 301.st
  ACCOUNT_ID: string;
  CF_API_TOKEN?: string;    // для phishing check (опционально)

  // Variables
  WEBHOOK_URL: string;
}

export interface DomainThreat {
  domain_name: string;
  threat_score: number;
  categories: string[];
  reputation: number;
  source: string;
  checked_at: string;
}

export interface ZonePhishing {
  zone_id: string;
  phishing_detected: boolean;
  checked_at: string;
}

// ============================================================
// MAIN WORKER
// ============================================================

export default {
  /**
   * HTTP Handler
   * - GET /health - health check (public)
   * - POST /run - manual trigger (protected)
   * - GET /stats - queue statistics (protected)
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check (public)
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        worker: "301-client",
        timestamp: new Date().toISOString(),
      });
    }

    // Protected endpoints require JWT validation could be added here
    // For now, workers.dev URL is not publicly routed

    // Manual run
    if (url.pathname === "/run" && request.method === "POST") {
      ctx.waitUntil(this.runFullCycle(env));
      return Response.json({ ok: true, message: "full_cycle_started" });
    }

    // Queue stats
    if (url.pathname === "/stats") {
      const stats = await this.getQueueStats(env);
      return Response.json({ ok: true, stats });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },

  /**
   * Cron Handler - запуск по расписанию
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[301-client] Cron triggered: ${event.cron}`);
    ctx.waitUntil(this.runFullCycle(env));
  },

  /**
   * Full Cycle (cron или manual /run)
   *
   * 1. Получить список активных доменов
   * 2. Проверить traffic anomalies → phishing check
   * 3. Добавить в очередь VT
   * 4. Обработать очередь VT
   * 5. Отправить webhook в 301.st
   */
  async runFullCycle(env: Env): Promise<void> {
    console.log("[301-client] Starting full cycle...");
    const startTime = Date.now();

    const zones: ZonePhishing[] = [];
    const threats: DomainThreat[] = [];

    try {
      // 1. Get active domains
      const domains = await getActiveDomains(env);
      console.log(`[301-client] Active domains: ${domains.length}`);

      if (domains.length === 0) {
        console.log("[301-client] No domains to check, skipping");
        return;
      }

      // 2. Check traffic anomalies → phishing
      if (env.CF_API_TOKEN) {
        const anomalies = await detectTrafficAnomalies(env);

        for (const anomaly of anomalies) {
          if (anomaly.type === "drop_90" || anomaly.type === "zero_traffic") {
            try {
              const result = await checkZonePhishing(anomaly.zone_id, env.CF_API_TOKEN);
              if (result.ok) {
                zones.push({
                  zone_id: anomaly.zone_id,
                  phishing_detected: result.phishing_detected,
                  checked_at: new Date().toISOString(),
                });
              }
            } catch (err) {
              console.error(`[301-client] Phishing check failed for zone ${anomaly.zone_id}:`, err);
            }
          }
        }
      }

      // 3. Add to VT queue
      await addDomainsToQueue(env, domains, 0, "virustotal");

      // 4. Process VT queue
      const vtResults = await processVTQueue(env);
      console.log(`[301-client] VT processed: ${vtResults.processed}, errors: ${vtResults.errors}`);
      threats.push(...vtResults.threats);

      // 5. Send webhook with all results
      if (zones.length > 0 || threats.length > 0) {
        const webhookResult = await sendHealthWebhook(env, { zones, threats });

        if (webhookResult.ok) {
          // Mark threats as synced
          const syncedDomains = threats.map((t) => t.domain_name);
          await markThreatsSynced(env, syncedDomains);
          console.log(`[301-client] Webhook sent: ${zones.length} zones, ${threats.length} threats`);
        } else {
          console.error(`[301-client] Webhook failed: ${webhookResult.error}`);
        }
      }

      const duration = Date.now() - startTime;
      console.log(`[301-client] Full cycle completed in ${duration}ms`);
    } catch (err) {
      console.error("[301-client] Full cycle error:", err);
    }
  },

  /**
   * Get queue statistics
   */
  async getQueueStats(env: Env): Promise<Record<string, number>> {
    const result = await env.DB.prepare(`
      SELECT status, COUNT(*) as count
      FROM threat_check_queue
      GROUP BY status
    `).all<{ status: string; count: number }>();

    const stats: Record<string, number> = {
      pending: 0,
      processing: 0,
      done: 0,
      error: 0,
    };

    for (const row of result.results) {
      stats[row.status] = row.count;
    }

    return stats;
  },
};
