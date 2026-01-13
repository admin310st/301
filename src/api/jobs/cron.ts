// src/system/cron.ts

/**
 * Cron Dispatcher
 * 
 * Диспетчер периодических задач.
 * Запускается по расписанию из wrangler.toml
 */

import { Env } from "../types/worker";

// Cloudflare providers
import { checkPendingZones } from "../integrations/providers/cloudflare/zones";
import { verifyAccountKeys as verifyCFKeys } from "../integrations/providers/cloudflare/keys";

// Redirect stats
import { updateRedirectStats } from "./redirect-stats";

// TODO: Namecheap providers
// import { checkDomainExpiration } from "../api/integrations/providers/namecheap/domains";
// import { verifyAccountKeys as verifyNCKeys } from "../api/integrations/providers/namecheap/keys";

// ============================================================
// TYPES
// ============================================================

interface CronSettings {
  check_activation_interval: number;  // минуты: 15, 30, 45, 60
  cache_ttl: number;                  // минуты
  verify_keys_interval: number;       // минуты (1440 = 24 часа)
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Получить настройки cron из KV
 */
async function getCronSettings(env: Env): Promise<CronSettings> {
  const settings = await env.KV_CREDENTIALS.get("settings:cron");
  
  if (settings) {
    return JSON.parse(settings);
  }

  // Defaults
  return {
    check_activation_interval: 15,
    cache_ttl: 15,
    verify_keys_interval: 1440, // 24 часа
  };
}

/**
 * Выполнить задачу с логированием в console
 */
async function runTask<T>(
  taskName: string,
  task: () => Promise<T>
): Promise<T> {
  const startTime = Date.now();

  try {
    const result = await task();
    console.log(`[CRON] ${taskName}: ${Date.now() - startTime}ms`, result);
    return result;
  } catch (error) {
    console.error(`[CRON] ${taskName} FAILED: ${Date.now() - startTime}ms`, error);
    throw error;
  }
}

// ============================================================
// CRON TASKS
// ============================================================

/**
 * Задача: Проверка NS pending зон
 * Интервал: настраиваемый (15/30/45/60 мин)
 */
async function taskCheckPendingZones(env: Env): Promise<void> {
  await runTask("checkPendingZones", () => checkPendingZones(env));
}

/**
 * Задача: Проверка валидности ключей CF
 * Интервал: 24 часа
 */
async function taskVerifyCFKeys(env: Env): Promise<void> {
  await runTask("verifyCFKeys", () => verifyCFKeys(env));
}

/**
 * Задача: Сбор статистики редиректов
 * Интервал: 24 часа (02:00 UTC)
 * Источник: CF GraphQL Analytics API
 */
async function taskUpdateRedirectStats(env: Env): Promise<void> {
  await runTask("updateRedirectStats", () => updateRedirectStats(env));
}

// ============================================================
// MAIN HANDLER
// ============================================================

export default {
  /**
   * Scheduled event handler
   * Вызывается Cloudflare по расписанию из wrangler.toml
   */
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const settings = await getCronSettings(env);
    const now = new Date(event.scheduledTime);
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();

    console.log(`[CRON] Triggered at ${now.toISOString()} (${hour}:${minute} UTC)`);

    // ========================================
    // Каждые N минут — проверка pending зон
    // ========================================
    const activationInterval = settings.check_activation_interval;
    if (minute % activationInterval === 0) {
      ctx.waitUntil(taskCheckPendingZones(env));
    }

    // ========================================
    // Раз в 24 часа (00:00 UTC) — проверка ключей CF
    // ========================================
    if (hour === 0 && minute === 0) {
      ctx.waitUntil(taskVerifyCFKeys(env));
    }

    // ========================================
    // Раз в 24 часа (02:00 UTC) — сбор статистики редиректов
    // ========================================
    if (hour === 2 && minute === 0) {
      ctx.waitUntil(taskUpdateRedirectStats(env));
    }

    // ========================================
    // TODO: Другие провайдеры
    // ========================================
    // Namecheap: проверка expiration доменов
    // if (hour === 6 && minute === 0) {
    //   ctx.waitUntil(taskCheckDomainExpiration(env));
    // }
  },
};

// ============================================================
// API HANDLERS (для ручного запуска)
// ============================================================

import { Context } from "hono";

/**
 * POST /system/cron/run
 * Ручной запуск cron задачи (только admin)
 */
export async function handleRunCronTask(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  // TODO: проверка admin роли
  // const auth = await requireAdmin(c, env);

  let body: { task: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { task } = body;

  switch (task) {
    case "checkPendingZones":
      const zonesResult = await checkPendingZones(env);
      return c.json({ ok: true, result: zonesResult });

    case "verifyCFKeys":
      const keysResult = await verifyCFKeys(env);
      return c.json({ ok: true, result: keysResult });

    case "updateRedirectStats":
      const statsResult = await updateRedirectStats(env);
      return c.json({ ok: true, result: statsResult });

    default:
      return c.json({ ok: false, error: "unknown_task" }, 400);
  }
}

/**
 * GET /system/cron/settings
 * Получить настройки cron
 */
export async function handleGetCronSettings(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const settings = await getCronSettings(env);
  return c.json({ ok: true, settings });
}

/**
 * PUT /system/cron/settings
 * Обновить настройки cron
 */
export async function handleUpdateCronSettings(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  // TODO: проверка admin роли

  let body: Partial<CronSettings>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  // Валидация
  const validIntervals = [15, 30, 45, 60];
  
  if (body.check_activation_interval && !validIntervals.includes(body.check_activation_interval)) {
    return c.json({ ok: false, error: "invalid_interval", valid: validIntervals }, 400);
  }

  if (body.cache_ttl && !validIntervals.includes(body.cache_ttl)) {
    return c.json({ ok: false, error: "invalid_cache_ttl", valid: validIntervals }, 400);
  }

  // Получаем текущие настройки и мержим
  const current = await getCronSettings(env);
  const updated: CronSettings = {
    ...current,
    ...body,
  };

  await env.KV_CREDENTIALS.put("settings:cron", JSON.stringify(updated));

  return c.json({ ok: true, settings: updated });
}
