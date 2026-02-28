// src/api/integrations/providers/cloudflare/workers.ts

/**
 * Cloudflare Workers API
 *
 * Управление воркерами на аккаунте клиента:
 * - Установка секретов (VT_API_KEY, JWT_TOKEN, etc.)
 * - Список секретов
 * - Удаление секретов
 *
 * Используется для настройки Client Worker после деплоя.
 */

// ============================================================
// TYPES
// ============================================================

interface CFApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
}

interface CFWorkerSecret {
  name: string;
  type: string;  // "secret_text"
}

interface CFWorkerScript {
  id: string;
  tag: string;
  etag: string;
  handlers: string[];
  modified_on: string;
  created_on: string;
  usage_model: string;
}

// ============================================================
// CONSTANTS
// ============================================================

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

// ============================================================
// SECRETS API
// ============================================================

/**
 * Установить секрет для воркера
 *
 * PUT /accounts/{account_id}/workers/scripts/{script_name}/secrets
 */
export async function setWorkerSecret(
  cfAccountId: string,
  scriptName: string,
  secretName: string,
  secretValue: string,
  token: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/workers/scripts/${scriptName}/secrets`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: secretName,
          text: secretValue,
          type: "secret_text",
        }),
      }
    );

    const data = (await response.json()) as CFApiResponse<CFWorkerSecret>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Failed to set secret";
      return { ok: false, error: errMsg };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Установить несколько секретов для воркера
 */
export async function setWorkerSecrets(
  cfAccountId: string,
  scriptName: string,
  secrets: Record<string, string>,
  token: string
): Promise<{ ok: boolean; set: string[]; errors: Array<{ name: string; error: string }> }> {
  const set: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const [name, value] of Object.entries(secrets)) {
    const result = await setWorkerSecret(cfAccountId, scriptName, name, value, token);

    if (result.ok) {
      set.push(name);
    } else {
      errors.push({ name, error: result.error || "Unknown error" });
    }
  }

  return {
    ok: errors.length === 0,
    set,
    errors,
  };
}

/**
 * Получить список секретов воркера (только имена, не значения)
 *
 * GET /accounts/{account_id}/workers/scripts/{script_name}/secrets
 */
export async function listWorkerSecrets(
  cfAccountId: string,
  scriptName: string,
  token: string
): Promise<{ ok: boolean; secrets?: string[]; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/workers/scripts/${scriptName}/secrets`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = (await response.json()) as CFApiResponse<CFWorkerSecret[]>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Failed to list secrets";
      return { ok: false, error: errMsg };
    }

    const secretNames = data.result.map((s) => s.name);
    return { ok: true, secrets: secretNames };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Удалить секрет воркера
 *
 * DELETE /accounts/{account_id}/workers/scripts/{script_name}/secrets/{secret_name}
 */
export async function deleteWorkerSecret(
  cfAccountId: string,
  scriptName: string,
  secretName: string,
  token: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/workers/scripts/${scriptName}/secrets/${secretName}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = (await response.json()) as CFApiResponse<null>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Failed to delete secret";
      return { ok: false, error: errMsg };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

// ============================================================
// WORKER INFO API
// ============================================================

/**
 * Проверить существование воркера
 *
 * GET /accounts/{account_id}/workers/scripts/{script_name}
 */
export async function checkWorkerExists(
  cfAccountId: string,
  scriptName: string,
  token: string
): Promise<{ exists: boolean; script?: CFWorkerScript; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/workers/scripts/${scriptName}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (response.status === 404) {
      return { exists: false };
    }

    // Worker content is returned as script, not JSON
    // For existence check, 200 = exists
    if (response.ok) {
      return { exists: true };
    }

    return { exists: false, error: `HTTP ${response.status}` };
  } catch (err) {
    return { exists: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Получить список воркеров на аккаунте
 *
 * GET /accounts/{account_id}/workers/scripts
 */
export async function listWorkers(
  cfAccountId: string,
  token: string
): Promise<{ ok: boolean; scripts?: CFWorkerScript[]; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/workers/scripts`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = (await response.json()) as CFApiResponse<CFWorkerScript[]>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Failed to list workers";
      return { ok: false, error: errMsg };
    }

    return { ok: true, scripts: data.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

// ============================================================
// DEPLOY API
// ============================================================

/**
 * Worker bindings configuration
 */
export interface WorkerBindings {
  d1?: Array<{ name: string; id: string }>;                    // D1 database bindings
  kv?: Array<{ name: string; namespace_id: string }>;          // KV namespace bindings
  durable_objects?: Array<{                                     // DO bindings
    name: string;
    class_name: string;
    script_name?: string;  // If different script
  }>;
  vars?: Record<string, string>;                                // Plain text variables
  crons?: string[];                                             // Cron triggers
}

/**
 * Metadata for worker deployment
 */
interface WorkerMetadata {
  main_module: string;
  bindings: Array<{
    type: string;
    name: string;
    [key: string]: unknown;
  }>;
  compatibility_date?: string;
  usage_model?: string;
}

/**
 * Deploy worker script with bindings
 *
 * PUT /accounts/{account_id}/workers/scripts/{script_name}
 *
 * Uses multipart/form-data with:
 * - worker.js: the script content
 * - metadata: JSON with bindings configuration
 */
export async function deployWorkerScript(
  cfAccountId: string,
  scriptName: string,
  scriptContent: string,
  bindings: WorkerBindings,
  token: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Build metadata bindings array
    const metadataBindings: WorkerMetadata["bindings"] = [];

    // D1 bindings
    if (bindings.d1) {
      for (const d1 of bindings.d1) {
        metadataBindings.push({
          type: "d1",
          name: d1.name,
          id: d1.id,
        });
      }
    }

    // KV bindings
    if (bindings.kv) {
      for (const kv of bindings.kv) {
        metadataBindings.push({
          type: "kv_namespace",
          name: kv.name,
          namespace_id: kv.namespace_id,
        });
      }
    }

    // Durable Objects bindings
    if (bindings.durable_objects) {
      for (const dob of bindings.durable_objects) {
        metadataBindings.push({
          type: "durable_object_namespace",
          name: dob.name,
          class_name: dob.class_name,
          ...(dob.script_name && { script_name: dob.script_name }),
        });
      }
    }

    // Plain text variables
    if (bindings.vars) {
      for (const [name, value] of Object.entries(bindings.vars)) {
        metadataBindings.push({
          type: "plain_text",
          name,
          text: value,
        });
      }
    }

    // Build metadata
    const metadata: WorkerMetadata = {
      main_module: "worker.js",
      bindings: metadataBindings,
      compatibility_date: "2025-01-01",
      usage_model: "bundled",
    };

    // Create multipart form data
    const formData = new FormData();

    // Add script as worker.js
    formData.append(
      "worker.js",
      new Blob([scriptContent], { type: "application/javascript+module" }),
      "worker.js"
    );

    // Add metadata
    formData.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" })
    );

    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/workers/scripts/${scriptName}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      }
    );

    const data = (await response.json()) as CFApiResponse<CFWorkerScript>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Failed to deploy worker";
      return { ok: false, error: errMsg };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Set cron triggers for worker
 *
 * PUT /accounts/{account_id}/workers/scripts/{script_name}/schedules
 */
export async function setWorkerCrons(
  cfAccountId: string,
  scriptName: string,
  crons: string[],
  token: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/workers/scripts/${scriptName}/schedules`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(crons.map(cron => ({ cron }))),
      }
    );

    const data = (await response.json()) as CFApiResponse<unknown>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Failed to set cron triggers";
      return { ok: false, error: errMsg };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Get cron triggers for worker
 *
 * GET /accounts/{account_id}/workers/scripts/{script_name}/schedules
 */
export async function getWorkerCrons(
  cfAccountId: string,
  scriptName: string,
  token: string
): Promise<{ ok: boolean; crons?: string[]; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/workers/scripts/${scriptName}/schedules`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await response.json()) as any;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Failed to get cron triggers";
      return { ok: false, error: errMsg };
    }

    // CF API may return { result: { schedules: [...] } } or { result: [...] }
    const schedules = data.result?.schedules || data.result;
    return {
      ok: true,
      crons: (Array.isArray(schedules) ? schedules : []).map((s: { cron: string }) => s.cron),
      _raw: data.result,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Delete worker script
 *
 * DELETE /accounts/{account_id}/workers/scripts/{script_name}
 */
export async function deleteWorkerScript(
  cfAccountId: string,
  scriptName: string,
  token: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/workers/scripts/${scriptName}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (response.status === 404) {
      return { ok: true }; // Already deleted
    }

    const data = (await response.json()) as CFApiResponse<null>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Failed to delete worker";
      return { ok: false, error: errMsg };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

// ============================================================
// ROUTES API
// ============================================================

interface CFWorkerRoute {
  id: string;
  pattern: string;
  script: string;
}

/**
 * Create worker route in zone
 *
 * POST /zones/{zone_id}/workers/routes
 */
export async function createWorkerRoute(
  zoneId: string,
  pattern: string,
  scriptName: string,
  token: string
): Promise<{ ok: boolean; route_id?: string; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${zoneId}/workers/routes`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          pattern,
          script: scriptName,
        }),
      }
    );

    const data = (await response.json()) as CFApiResponse<CFWorkerRoute>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Failed to create route";
      return { ok: false, error: errMsg };
    }

    return { ok: true, route_id: data.result.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * List worker routes in zone
 *
 * GET /zones/{zone_id}/workers/routes
 */
export async function listWorkerRoutes(
  zoneId: string,
  token: string
): Promise<{ ok: boolean; routes?: CFWorkerRoute[]; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${zoneId}/workers/routes`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = (await response.json()) as CFApiResponse<CFWorkerRoute[]>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Failed to list routes";
      return { ok: false, error: errMsg };
    }

    return { ok: true, routes: data.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Delete worker route
 *
 * DELETE /zones/{zone_id}/workers/routes/{route_id}
 */
export async function deleteWorkerRoute(
  zoneId: string,
  routeId: string,
  token: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${zoneId}/workers/routes/${routeId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const data = (await response.json()) as CFApiResponse<null>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Failed to delete route";
      return { ok: false, error: errMsg };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

