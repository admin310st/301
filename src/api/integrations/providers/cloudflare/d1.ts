// src/api/integrations/providers/cloudflare/d1.ts

/**
 * Cloudflare D1 Database Management
 *
 * API функции для работы с D1 на аккаунте клиента:
 * - Проверка существования D1
 * - Создание D1
 * - Выполнение SQL запросов
 * - Полный setup flow для Client Worker
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

interface CFD1Database {
  uuid: string;
  name: string;
  version: string;
  num_tables: number;
  file_size: number;
  created_at: string;
}

interface CFD1QueryResult {
  results: Record<string, unknown>[];
  success: boolean;
  meta: {
    served_by: string;
    duration: number;
    changes: number;
    last_row_id: number;
    changed_db: boolean;
    size_after: number;
    rows_read: number;
    rows_written: number;
  };
}

export interface D1SetupResult {
  ok: boolean;
  database_id?: string;
  database_name?: string;
  created?: boolean;
  tables_created?: boolean;
  error?: string;
}

// ============================================================
// CONSTANTS
// ============================================================

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

// ============================================================
// API FUNCTIONS
// ============================================================

/**
 * Получить список D1 баз на аккаунте
 */
export async function listD1Databases(
  cfAccountId: string,
  token: string
): Promise<{ ok: boolean; databases?: CFD1Database[]; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/d1/database`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = (await response.json()) as CFApiResponse<CFD1Database[]>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Unknown CF API error";
      return { ok: false, error: errMsg };
    }

    return { ok: true, databases: data.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Проверить существование D1 по имени
 */
export async function checkD1Exists(
  cfAccountId: string,
  dbName: string,
  token: string
): Promise<{ exists: boolean; database?: CFD1Database; error?: string }> {
  const listResult = await listD1Databases(cfAccountId, token);

  if (!listResult.ok) {
    return { exists: false, error: listResult.error };
  }

  const db = listResult.databases?.find((d) => d.name === dbName);

  if (db) {
    return { exists: true, database: db };
  }

  return { exists: false };
}

/**
 * Создать D1 базу данных
 */
export async function createD1Database(
  cfAccountId: string,
  dbName: string,
  token: string
): Promise<{ ok: boolean; database?: CFD1Database; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/d1/database`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: dbName }),
      }
    );

    const data = (await response.json()) as CFApiResponse<CFD1Database>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Failed to create D1";
      return { ok: false, error: errMsg };
    }

    return { ok: true, database: data.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Выполнить SQL запрос на D1
 *
 * @param cfAccountId - CF Account ID
 * @param databaseId - D1 Database UUID
 * @param sql - SQL запрос (может содержать несколько statements через ;)
 * @param token - CF API Token
 */
export async function executeD1Query(
  cfAccountId: string,
  databaseId: string,
  sql: string,
  token: string
): Promise<{ ok: boolean; results?: CFD1QueryResult[]; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/d1/database/${databaseId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql }),
      }
    );

    const data = (await response.json()) as CFApiResponse<CFD1QueryResult[]>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Query execution failed";
      return { ok: false, error: errMsg };
    }

    return { ok: true, results: data.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Получить информацию о D1 по UUID
 */
export async function getD1Database(
  cfAccountId: string,
  databaseId: string,
  token: string
): Promise<{ ok: boolean; database?: CFD1Database; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/d1/database/${databaseId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = (await response.json()) as CFApiResponse<CFD1Database>;

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Database not found";
      return { ok: false, error: errMsg };
    }

    return { ok: true, database: data.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

// ============================================================
// DELETE
// ============================================================

/**
 * Delete D1 database
 *
 * DELETE /accounts/{account_id}/d1/database/{database_id}
 */
export async function deleteD1Database(
  cfAccountId: string,
  databaseId: string,
  token: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/d1/database/${databaseId}`,
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
      const errMsg = data.errors?.[0]?.message || "Failed to delete D1";
      return { ok: false, error: errMsg };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

// ============================================================
// SETUP FLOW
// ============================================================

export interface D1SetupOptions {
  cfAccountId: string;
  token: string;
  dbName: string;
  schema?: string;  // SQL schema to execute (optional)
}

/**
 * Setup D1 database (universal)
 *
 * 1. Проверить существование D1 по имени
 * 2. Если нет — создать
 * 3. Выполнить schema SQL (если передан)
 * 4. Вернуть database_id для binding в Worker
 *
 * @example
 * // Health Check D1
 * await setupD1({ cfAccountId, token, dbName: "301-client", schema: healthSchema });
 *
 * // TDS D1
 * await setupD1({ cfAccountId, token, dbName: "301-tds", schema: tdsSchema });
 */
export async function setupD1(options: D1SetupOptions): Promise<D1SetupResult> {
  const { cfAccountId, token, dbName, schema } = options;

  // 1. Check if D1 exists
  const checkResult = await checkD1Exists(cfAccountId, dbName, token);

  if (checkResult.error) {
    return { ok: false, error: checkResult.error };
  }

  let database: CFD1Database;
  let created = false;

  if (checkResult.exists && checkResult.database) {
    // D1 already exists
    database = checkResult.database;
  } else {
    // 2. Create D1
    const createResult = await createD1Database(cfAccountId, dbName, token);

    if (!createResult.ok || !createResult.database) {
      return { ok: false, error: createResult.error || "Failed to create D1" };
    }

    database = createResult.database;
    created = true;
  }

  // 3. Execute schema if provided (idempotent with IF NOT EXISTS)
  let tablesCreated = false;
  if (schema) {
    const schemaResult = await executeD1Query(cfAccountId, database.uuid, schema, token);

    if (!schemaResult.ok) {
      return {
        ok: false,
        database_id: database.uuid,
        database_name: database.name,
        created,
        error: `Schema error: ${schemaResult.error}`,
      };
    }
    tablesCreated = true;
  }

  return {
    ok: true,
    database_id: database.uuid,
    database_name: database.name,
    created,
    tables_created: tablesCreated,
  };
}
