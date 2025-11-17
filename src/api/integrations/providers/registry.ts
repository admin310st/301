// src/api/integrations/providers/registry.ts
/**
 * registry.ts
 * Реестр поддерживаемых внешних провайдеров для интеграций.
 * Используется в CRUD ключей и в healthcheck-задачах.
 */

export const Providers = {
  NAMESILO: "namesilo",
  NAMECHEAP: "namecheap",
  HOSTTRACKER: "hosttracker",
  GOOGLE_ANALYTICS: "google_analytics",
  YANDEX_METRICA: "yandex_metrica",
} as const;

// Тип всех доступных провайдеров
export type Provider = (typeof Providers)[keyof typeof Providers];

// генерация ALLOWLIST из Providers
export const ALLOWLIST: readonly Provider[] = Object.values(Providers);

// Проверка провайдера
export function validateProvider(provider: unknown): provider is Provider {
  return typeof provider === "string" && ALLOWLIST.includes(provider as Provider);
}

