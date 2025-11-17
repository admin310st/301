// src/api/lib/kv.ts
// Чистая, строгая KV-библиотека для 301.st
// Без обратной совместимости. Только namespace-based API.

import type { Env } from "../types/worker";

export const kv = {
  /**
   * Выбор namespace:
   *   kv.ns(env.KV_SESSIONS).put(...)
   *   kv.ns(env.KV_CREDENTIALS).getJson(...)
   */
  ns(namespace: KVNamespace) {
    return {
      // STRING GET
      async get(key: string): Promise<string | null> {
        return await namespace.get(key);
      },

      // JSON GET
      async getJson<T>(key: string): Promise<T | null> {
        const raw = await namespace.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
      },

      // STRING / JSON PUT
      async put(key: string, value: any, ttl?: number): Promise<void> {
        const body =
          typeof value === "string" ? value : JSON.stringify(value);

        if (ttl) {
          await namespace.put(key, body, { expirationTtl: ttl });
        } else {
          await namespace.put(key, body);
        }
      },

      // DELETE
      async del(key: string): Promise<void> {
        await namespace.delete(key);
      },
    };
  },
};

