// src/api/integrations/index.ts

// entrypoint для всего модуля интеграций 301.
// Providers registry (единственный источник)
export * from "./providers/registry";

// Keys: хранение шифрованных API-ключей
export * from "./keys/storage";

// Cloudflare
export { handleInitKeyCF } from "./providers/cloudflare/initkey";
export * from "./providers/cloudflare/permissions";

// Namecheap
export { handleInitKeyNamecheap } from "./providers/namecheap/initkey";

// Адаптеры (по необходимости)
export * as Namecheap from "./providers/namecheap/namecheap";
export * as Namesilo from "./providers/namesilo";
export * as Hosttracker from "./providers/hosttracker";
export * as GoogleAnalytics from "./providers/google_analytics";
export * as YandexMetrica from "./providers/yandex_metrica";
