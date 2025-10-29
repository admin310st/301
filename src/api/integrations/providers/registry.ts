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

export type Provider = (typeof Providers)[keyof typeof Providers];

// --- ALLOWLIST для валидации входных данных (используется в Zod)
export const ALLOWLIST = Object.values(Providers);


/**
 * Возвращает человекочитаемое название провайдера (для UI / логов)
 */
export function getProviderLabel(provider: Provider): string {
  const labels: Record<Provider, string> = {
    namesilo: "NameSilo",
    namecheap: "Namecheap",
    hosttracker: "HostTracker",
    google_analytics: "Google Analytics",
    yandex_metrica: "Yandex Metrica",
  };
  return labels[provider];
}

/**
 * получение обработчика провайдера
 * (lazy-import, чтобы не тянуть все реализации сразу)
 */
export async function getProviderModule(provider: Provider) {
  switch (provider) {
    case "namesilo":
      return import("./namesilo");
    case "namecheap":
      return import("./namecheap");
    case "hosttracker":
      return import("./hosttracker");
    case "google_analytics":
      return import("./google_analytics");
    case "yandex_metrica":
      return import("./yandex_metrica");
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

