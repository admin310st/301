// src/api/integrations/index.ts
//
// entrypoint для всего модуля интеграций 301.
// Используется эндпоинтами API 301 и внутренними сервисами.
// Providers registry (единственный источник)
//
export * from "./providers/registry";

// Keys: хранение шифрованных API-ключей
export * from "./keys/schema";
export * from "./keys/storage";

// Адаптеры вызываются по необходимости,
export * as Namecheap from "./providers/namecheap";
export * as Namesilo from "./providers/namesilo";
export * as Hosttracker from "./providers/hosttracker";
export * as GoogleAnalytics from "./providers/google_analytics";
export * as YandexMetrica from "./providers/yandex_metrica";

