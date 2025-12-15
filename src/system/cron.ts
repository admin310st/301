// src/api/system/cron.ts

/**
 * Cron Dispatcher
 * 
 * Диспетчер периодических задач.
 * Запускается по расписанию из wrangler.toml
 */

import { Env } from "../types/worker";

// Cloudflare providers
import { Env } from "../api/types/worker";
import { checkPendingZones } from "../api/integrations/providers/cloudflare/zones";
import { verifyAccountKeys as verifyCFKeys } from "../api/integrations/providers/cloudflare/keys";

// TODO: Namecheap providers
// import { checkDomainExpiration } from "../integrations/providers/namecheap/domains";
// import { verifyAccountKeys as verifyNCKeys } from "../integrations/providers/namecheap/keys";

// ============================================================
// TYPES
// ============================================================

interface CronSettings {
  check_activation_interval: number;  // минуты: 15, 30, 45, 60
  cache_ttl: number;                  // минуты
  verify_keys_interval: number;       // минуты (1440 = 24 часа)
}

interface CronStats {
  task: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  result: Record<string, unknown>;
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
 * Логировать результат задачи
 */
async function logCronResult(env: Env, stats: CronStats): Promise<void> {
  // Сохраняем в KV (последние 100 записей)
  const key = `cron:log:${stats.started_at}`;
  await env.KV_CREDENTIALS.put(key, JSON.stringify(stats), {
    expirationTtl: 7 * 24 * 60 * 60, // 7 дней
  });

  console.log(`[CRON] ${stats.task}: ${stats.duration_ms}ms`, stats.result);
}

/**
 * Выполнить задачу с логированием
 */
async function runTask<T>(
  env: Env,
  taskName: string,
  task: () => Promise<T>
): Promise<T> {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  try {
    const result = await task();
    
    await logCronResult(env, {
      task: taskName,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      result: result as Record<string, unknown>,
    });

    return result;
  } catch (error) {
    await logCronResult(env, {
      task: taskName,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      result: { error: String(error) },
    });
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
  await runTask(env, "checkPendingZones", () => checkPendingZones(env));
}

/**
 * Задача: Проверка валидности ключей CF
 * Интервал: 24 часа
 */
async function taskVerifyCFKeys(env: Env): Promise<void> {
  await runTask(env, "verifyCFKeys", () => verifyCFKeys(env));
}

// TODO: Namecheap tasks
// async function taskCheckDomainExpiration(env: Env): Promise<void> {
//   await runTask(env, "checkDomainExpiration", () => checkDomainExpiration(env));
// }

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

/**
 * GET /system/cron/logs
 * Получить логи cron задач
 */
export async function handleGetCronLogs(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const limit = parseInt(c.req.query("limit") || "20");

  // Получаем ключи логов
  const list = await env.KV_CREDENTIALS.list({ prefix: "cron:log:", limit });
  
  const logs: CronStats[] = [];
  for (const key of list.keys) {
    const value = await env.KV_CREDENTIALS.get(key.name);
    if (value) {
      logs.push(JSON.parse(value));
    }
  }

  // Сортируем по дате (новые первые)
  logs.sort((a, b) => b.started_at.localeCompare(a.started_at));

  return c.json({ ok: true, logs });
}

