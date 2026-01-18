// src/api/integrations/providers/cloudflare/kv.ts

/**
 * Cloudflare KV Namespace Management
 *
 * API функции для работы с KV на аккаунте клиента:
 * - Создание KV namespace
 * - Чтение/запись значений
 * - Удаление namespace
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

interface CFKVNamespace {
  id: string;
  title: string;
  supports_url_encoding: boolean;
}

// ============================================================
// CONSTANTS
// ============================================================

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

// ============================================================
// NAMESPACE API
// ============================================================

/**
 * Получить список KV namespaces на аккаунте
 */
export async function listKVNamespaces(
  cfAccountId: string,
  token: string
): Promise<{ ok: boolean; namespaces?: CFKVNamespace[]; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/storage/kv/namespaces`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = (await response.json()) as CFApiResponse<CFKVNamespace[]>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Unknown CF API error";
      return { ok: false, error: errMsg };
    }

    return { ok: true, namespaces: data.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Проверить существование KV namespace по имени
 */
export async function checkKVExists(
  cfAccountId: string,
  title: string,
  token: string
): Promise<{ exists: boolean; namespace?: CFKVNamespace; error?: string }> {
  const listResult = await listKVNamespaces(cfAccountId, token);

  if (!listResult.ok) {
    return { exists: false, error: listResult.error };
  }

  const ns = listResult.namespaces?.find((n) => n.title === title);

  if (ns) {
    return { exists: true, namespace: ns };
  }

  return { exists: false };
}

/**
 * Создать KV namespace
 */
export async function createKVNamespace(
  cfAccountId: string,
  title: string,
  token: string
): Promise<{ ok: boolean; namespace?: CFKVNamespace; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/storage/kv/namespaces`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title }),
      }
    );

    const data = (await response.json()) as CFApiResponse<CFKVNamespace>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Failed to create KV namespace";
      return { ok: false, error: errMsg };
    }

    return { ok: true, namespace: data.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Удалить KV namespace
 */
export async function deleteKVNamespace(
  cfAccountId: string,
  namespaceId: string,
  token: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/storage/kv/namespaces/${namespaceId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const data = (await response.json()) as CFApiResponse<null>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Failed to delete KV namespace";
      return { ok: false, error: errMsg };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

// ============================================================
// KEY-VALUE API
// ============================================================

/**
 * Записать значение в KV
 */
export async function putKVValue(
  cfAccountId: string,
  namespaceId: string,
  key: string,
  value: string,
  token: string,
  options?: { expiration_ttl?: number; metadata?: Record<string, unknown> }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = new URL(
      `${CF_API_BASE}/accounts/${cfAccountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`
    );

    if (options?.expiration_ttl) {
      url.searchParams.set("expiration_ttl", String(options.expiration_ttl));
    }

    const response = await fetch(url.toString(), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: value,
    });

    if (!response.ok) {
      const data = await response.json() as CFApiResponse<null>;
      const errMsg = data.errors?.[0]?.message || `HTTP ${response.status}`;
      return { ok: false, error: errMsg };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Прочитать значение из KV
 */
export async function getKVValue(
  cfAccountId: string,
  namespaceId: string,
  key: string,
  token: string
): Promise<{ ok: boolean; value?: string; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (response.status === 404) {
      return { ok: true, value: undefined };
    }

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const value = await response.text();
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Удалить значение из KV
 */
export async function deleteKVValue(
  cfAccountId: string,
  namespaceId: string,
  key: string,
  token: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!response.ok && response.status !== 404) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

// ============================================================
// SETUP FLOW
// ============================================================

export interface KVSetupResult {
  ok: boolean;
  namespace_id?: string;
  namespace_title?: string;
  created?: boolean;
  error?: string;
}

/**
 * Setup KV namespace (create if not exists)
 */
export async function setupKV(
  cfAccountId: string,
  title: string,
  token: string
): Promise<KVSetupResult> {
  // 1. Check if exists
  const checkResult = await checkKVExists(cfAccountId, title, token);

  if (checkResult.error) {
    return { ok: false, error: checkResult.error };
  }

  if (checkResult.exists && checkResult.namespace) {
    return {
      ok: true,
      namespace_id: checkResult.namespace.id,
      namespace_title: checkResult.namespace.title,
      created: false,
    };
  }

  // 2. Create
  const createResult = await createKVNamespace(cfAccountId, title, token);

  if (!createResult.ok || !createResult.namespace) {
    return { ok: false, error: createResult.error || "Failed to create KV" };
  }

  return {
    ok: true,
    namespace_id: createResult.namespace.id,
    namespace_title: createResult.namespace.title,
    created: true,
  };
}
