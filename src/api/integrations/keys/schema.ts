// src/api/integrations/keys/schema.ts

import { Providers, type Provider } from "../providers/registry";

// Схемы обязательных полей для каждого провайдера

export interface ProviderKeySchemas {
  [Providers.NAMECHEAP]: {
    apiKey: string;
    username: string;
  };

  [Providers.NAMESILO]: {
    apiKey: string;
  };

  [Providers.HOSTTRACKER]: {
    token: string;
  };

  [Providers.GOOGLE_ANALYTICS]: {
    clientId: string;
    clientSecret: string;
  };

  [Providers.YANDEX_METRICA]: {
    token: string;
  };
}

// Универсальный тип: данные ключа для выбранного провайдера
export type ProviderKeyData = ProviderKeySchemas[Provider];

