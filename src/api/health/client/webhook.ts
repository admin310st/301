/**
 * Webhook Sender (Push Model)
 *
 * Отправляет данные напрямую в 301.st
 * 301.st валидирует JWT и обрабатывает данные
 */

import type { Env, DomainThreat, ZonePhishing } from "./index";

// ============================================================
// TYPES
// ============================================================

interface WebhookPayload {
  account_id: string;
  timestamp: string;
  zones: ZonePhishing[];
  threats: DomainThreat[];
}

interface WebhookResponse {
  ok: boolean;
  error?: string;
  result?: {
    zones_processed: number;
    domains_blocked: number;
    threats_upserted: number;
  };
}

// ============================================================
// API
// ============================================================

/**
 * Отправить данные в 301.st (push model)
 *
 * - Авторизация: JWT_TOKEN
 * - Данные: zones + threats в body
 */
export async function sendHealthWebhook(
  env: Env,
  data: {
    zones?: ZonePhishing[];
    threats?: DomainThreat[];
  }
): Promise<{ ok: boolean; error?: string; result?: WebhookResponse["result"] }> {
  const zones = data.zones || [];
  const threats = data.threats || [];

  // Skip if nothing to report
  if (zones.length === 0 && threats.length === 0) {
    return { ok: true };
  }

  const payload: WebhookPayload = {
    account_id: env.ACCOUNT_ID,
    timestamp: new Date().toISOString(),
    zones,
    threats,
  };

  try {
    const response = await fetch(env.WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.JWT_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[Webhook] Failed: ${response.status} - ${text}`);
      return { ok: false, error: `http_${response.status}` };
    }

    const result = (await response.json()) as WebhookResponse;

    if (!result.ok) {
      return { ok: false, error: result.error || "webhook_error" };
    }

    return { ok: true, result: result.result };
  } catch (err) {
    console.error("[Webhook] Error:", err);
    return { ok: false, error: err instanceof Error ? err.message : "network_error" };
  }
}

/**
 * Пометить threats как отправленные (synced)
 */
export async function markThreatsSynced(env: Env, domains: string[]): Promise<void> {
  if (domains.length === 0) return;

  const now = new Date().toISOString();
  for (const domain of domains) {
    await env.DB.prepare(
      `UPDATE domain_threats SET synced_at = ? WHERE domain_name = ?`
    ).bind(now, domain).run();
  }
}
