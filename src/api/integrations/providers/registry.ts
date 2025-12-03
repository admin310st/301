// src/api/integrations/providers/registry.ts
/**
 * Registry провайдеров интеграций 301.st
 * 
 * ЕДИНСТВЕННЫЙ ИСТОЧНИК ПРАВДЫ для:
 * - Списка поддерживаемых провайдеров
 * - Полей для шифрования/хранения
 * - Валидации входных данных
 * - Эндпоинтов инициализации
 * 
 * schema — здесь!
 */

// ============================================
// PROVIDER DEFINITIONS
// ============================================

export const Providers = {
  /**
   * Cloudflare — основной провайдер для TDS
   * Особенности:
   * - Bootstrap → Working token flow
   * - permissions
   * - external_account_id = CF Account ID
   */
  CLOUDFLARE: {
    id: "cloudflare",
    name: "Cloudflare",
    description: "DNS, Workers, KV, D1, WAF, Redirects",
    initEndpoint: "/integrations/initkey/cf",
    
    // Поля которые ШИФРУЮТСЯ и хранятся в KV_CREDENTIALS
    fields: {
      token: { 
        required: true, 
        sensitive: true,
        description: "Working API Token (создаётся автоматически из bootstrap)"
      },
    },
    
    // Метаданные которые хранятся в provider_scope (D1, НЕ шифруются)
    metadata: {
      cf_token_id: { description: "ID токена в Cloudflare" },
      cf_token_name: { description: "Имя токена (301st-YYYYMMDD-HHMMSS)" },
    },
    
    // Специальные флаги
    hasBootstrap: true,           // Требует bootstrap token для создания working token
    externalAccountId: true,      // Требует CF Account ID
    externalAccountIdField: "cf_account_id",
    
    // Лимиты
    defaultExpiresYears: 5,
    maxExpiresYears: 10,
  },

  /**
   * Namecheap — регистратор доменов
   * Используется для:
   * - Получения списка доменов
   * - Смены NS на Cloudflare
   */
  NAMECHEAP: {
    id: "namecheap",
    name: "Namecheap",
    description: "Domain registrar — список доменов, смена NS",
    initEndpoint: "/integrations/initkey/namecheap",
    
    fields: {
      apiKey: { 
        required: true, 
        sensitive: true,
        description: "API Key из Namecheap Dashboard"
      },
      username: { 
        required: true, 
        sensitive: false,
        description: "Namecheap username"
      },
    },
    
    metadata: {
      whitelisted_ip: { description: "IP добавленный в whitelist Namecheap" },
    },
    
    hasBootstrap: false,
    externalAccountId: true,      // username служит идентификатором
    externalAccountIdField: "username",
    
    defaultExpiresYears: null,    // Namecheap API keys не истекают
    maxExpiresYears: null,
  },

  /**
   * Namesilo — регистратор доменов
   * Альтернатива Namecheap
   */
  NAMESILO: {
    id: "namesilo",
    name: "Namesilo",
    description: "Domain registrar — список доменов, смена NS",
    initEndpoint: "/integrations/initkey/namesilo",
    
    fields: {
      apiKey: { 
        required: true, 
        sensitive: true,
        description: "API Key из Namesilo"
      },
    },
    
    metadata: {},
    
    hasBootstrap: false,
    externalAccountId: false,     // API Key глобальный
    externalAccountIdField: null,
    
    defaultExpiresYears: null,
    maxExpiresYears: null,
  },

  /**
   * HostTracker — мониторинг доступности доменов
   * Используется для:
   * - Проверки доступности доменов
   * - Детекции блокировок
   */
  HOSTTRACKER: {
    id: "hosttracker",
    name: "HostTracker",
    description: "Мониторинг доступности доменов",
    initEndpoint: "/integrations/initkey/hosttracker",
    
    fields: {
      login: {
        required: true,
        sensitive: false,
        description: "Email для входа в HostTracker"
      },
      password: {
        required: true,
        sensitive: true,
        description: "Пароль (обменивается на token)"
      },
      token: { 
        required: false,  // Получается автоматически при initkey
        sensitive: true,
        description: "API Token (получается через login/password)"
      },
    },
    
    metadata: {
      token_expires_at: { description: "Время истечения токена" },
    },
    
    hasBootstrap: false,
    externalAccountId: true,
    externalAccountIdField: "login",
    
    defaultExpiresYears: 1,       // HostTracker токены обычно на год
    maxExpiresYears: 1,
  },

  /**
   * Google Analytics — аналитика
   * OAuth 2.0 flow
   */
  GOOGLE_ANALYTICS: {
    id: "google_analytics",
    name: "Google Analytics",
    description: "Веб-аналитика Google",
    initEndpoint: "/integrations/initkey/ga",
    
    fields: {
      accessToken: { 
        required: true, 
        sensitive: true,
        description: "OAuth Access Token"
      },
      refreshToken: { 
        required: true, 
        sensitive: true,
        description: "OAuth Refresh Token"
      },
    },
    
    metadata: {
      property_id: { description: "GA4 Property ID" },
      account_id: { description: "GA Account ID" },
    },
    
    hasBootstrap: false,          // OAuth flow, не bootstrap
    hasOAuth: true,               // Использует OAuth
    externalAccountId: true,
    externalAccountIdField: "account_id",
    
    defaultExpiresYears: null,    // Refresh token обновляется автоматически
    maxExpiresYears: null,
  },

  /**
   * Yandex Metrica — аналитика
   * OAuth 2.0 flow
   */
  YANDEX_METRICA: {
    id: "yandex_metrica",
    name: "Yandex Metrica",
    description: "Веб-аналитика Яндекс",
    initEndpoint: "/integrations/initkey/ym",
    
    fields: {
      token: { 
        required: true, 
        sensitive: true,
        description: "OAuth Token"
      },
    },
    
    metadata: {
      counter_id: { description: "ID счётчика Метрики" },
    },
    
    hasBootstrap: false,
    hasOAuth: true,
    externalAccountId: false,
    externalAccountIdField: null,
    
    defaultExpiresYears: null,
    maxExpiresYears: null,
  },
} as const;


// ============================================
// TYPES (автогенерация из Providers)
// ============================================

/** Ключ провайдера (CLOUDFLARE, NAMECHEAP, ...) */
export type ProviderKey = keyof typeof Providers;

/** ID провайдера (cloudflare, namecheap, ...) */
export type ProviderId = typeof Providers[ProviderKey]["id"];

/** Конфигурация провайдера */
export type ProviderConfig = typeof Providers[ProviderKey];

/** Список всех ID провайдеров */
export const PROVIDER_IDS = Object.values(Providers).map(p => p.id) as ProviderId[];


// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Получить конфигурацию провайдера по ID
 */
export function getProviderById(id: string): ProviderConfig | null {
  const entry = Object.entries(Providers).find(([_, config]) => config.id === id);
  return entry ? entry[1] : null;
}

/**
 * Получить конфигурацию провайдера по ключу
 */
export function getProviderByKey(key: ProviderKey): ProviderConfig {
  return Providers[key];
}

/**
 * Проверить что провайдер существует
 */
export function isValidProvider(id: unknown): id is ProviderId {
  return typeof id === "string" && PROVIDER_IDS.includes(id as ProviderId);
}

/**
 * Валидация полей провайдера
 * @throws Error если обязательное поле отсутствует
 */
export function validateProviderFields(
  providerId: string, 
  data: Record<string, unknown>
): void {
  const provider = getProviderById(providerId);
  
  if (!provider) {
    throw new Error("unknown_provider");
  }
  
  for (const [fieldName, fieldConfig] of Object.entries(provider.fields)) {
    const value = data[fieldName];
    
    if (fieldConfig.required) {
      if (value === undefined || value === null || value === "") {
        throw new Error(`${providerId}_${fieldName}_required`);
      }
    }
    
    // Проверка типа (все поля — строки)
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new Error(`${providerId}_${fieldName}_invalid_type`);
    }
  }
}

/**
 * Извлечь только sensitive поля для шифрования
 */
export function extractSensitiveFields(
  providerId: string,
  data: Record<string, unknown>
): Record<string, string> {
  const provider = getProviderById(providerId);
  
  if (!provider) {
    throw new Error("unknown_provider");
  }
  
  const sensitive: Record<string, string> = {};
  
  for (const [fieldName, fieldConfig] of Object.entries(provider.fields)) {
    if (fieldConfig.sensitive && data[fieldName]) {
      sensitive[fieldName] = String(data[fieldName]);
    }
  }
  
  return sensitive;
}

/**
 * Извлечь non-sensitive поля для metadata
 */
export function extractPublicFields(
  providerId: string,
  data: Record<string, unknown>
): Record<string, string> {
  const provider = getProviderById(providerId);
  
  if (!provider) {
    throw new Error("unknown_provider");
  }
  
  const publicFields: Record<string, string> = {};
  
  for (const [fieldName, fieldConfig] of Object.entries(provider.fields)) {
    if (!fieldConfig.sensitive && data[fieldName]) {
      publicFields[fieldName] = String(data[fieldName]);
    }
  }
  
  return publicFields;
}

/**
 * Получить поле external_account_id из данных
 */
export function extractExternalAccountId(
  providerId: string,
  data: Record<string, unknown>
): string | null {
  const provider = getProviderById(providerId);
  
  if (!provider || !provider.externalAccountId || !provider.externalAccountIdField) {
    return null;
  }
  
  const value = data[provider.externalAccountIdField];
  return value ? String(value) : null;
}

/**
 * Проверить требует ли провайдер bootstrap flow
 */
export function requiresBootstrap(providerId: string): boolean {
  const provider = getProviderById(providerId);
  return provider?.hasBootstrap ?? false;
}

/**
 * Проверить требует ли провайдер OAuth flow
 */
export function requiresOAuth(providerId: string): boolean {
  const provider = getProviderById(providerId);
  return (provider as any)?.hasOAuth ?? false;
}

/**
 * Получить срок действия по умолчанию (в годах)
 */
export function getDefaultExpiresYears(providerId: string): number | null {
  const provider = getProviderById(providerId);
  return provider?.defaultExpiresYears ?? null;
}

/**
 * Получить максимальный срок действия (в годах)
 */
export function getMaxExpiresYears(providerId: string): number | null {
  const provider = getProviderById(providerId);
  return provider?.maxExpiresYears ?? null;
}


// ============================================
// DEPRECATED (для обратной совместимости)
// ============================================

/**
 * @deprecated Используй isValidProvider()
 */
export function validateProvider(provider: unknown): provider is ProviderId {
  return isValidProvider(provider);
}

/**
 * @deprecated Используй PROVIDER_IDS
 */
export const ALLOWLIST: readonly ProviderId[] = PROVIDER_IDS;

