// src/api/integrations/providers/cloudflare/permissions.ts

/**
 * Cloudflare API Token Permissions
 * 
 * Обязательные разрешения для working token.
 * ID могут измениться со стороны CF — при ошибке правим вручную.
 * 
 * Источник: GET /accounts/{account_id}/tokens/permission_groups
 */

export interface CFPermission {
  id: string;
  name: string;
  scope: "account" | "zone";
}

/**
 * Полный список обязательных разрешений (33 шт. — могут меняться)
 */
export const CF_REQUIRED_PERMISSIONS: readonly CFPermission[] = [
  // ===== ACCOUNT SCOPE (12) =====
  { id: "c1fde68c7bcc44588cbb6ddbc16d6480", name: "Account Settings Read", scope: "account" },
  { id: "eb56a6953c034b9d97dd838155666f06", name: "Account API Tokens Read", scope: "account" },
  { id: "192192df92ee43ac90f2aeeffce67e35", name: "D1 Read", scope: "account" },
  { id: "09b2857d1c31407795e75e3fed8617a1", name: "D1 Write", scope: "account" },
  { id: "429a068902904c5a9ed9fc267c67da9a", name: "Mass URL Redirects Read", scope: "account" },
  { id: "abe78e2276664f4db588c1f675a77486", name: "Mass URL Redirects Write", scope: "account" },
  { id: "a9a99455bf3245f6a5a244f909d74830", name: "Transform Rules Read", scope: "account" },
  { id: "ae16e88bc7814753a1894c7ce187ab72", name: "Transform Rules Write", scope: "account" },
  { id: "8b47d2786a534c08a1f94ee8f9f599ef", name: "Workers KV Storage Read", scope: "account" },
  { id: "f7f0eda5697f475c90846e879bab8666", name: "Workers KV Storage Write", scope: "account" },
  { id: "1a71c399035b4950a1bd1466bbe4f420", name: "Workers Scripts Read", scope: "account" },
  { id: "e086da7e2179491d91ee5f35b3ca210a", name: "Workers Scripts Write", scope: "account" },

  // ===== ZONE SCOPE (21) =====
  { id: "c8fed203ed3043cba015a93ad1616f1f", name: "Zone Read", scope: "zone" },
  { id: "e6d2666161e84845a636613608cee8d5", name: "Zone Write", scope: "zone" },
  { id: "517b21aee92c4d89936c976ba6e4be55", name: "Zone Settings Read", scope: "zone" },
  { id: "3030687196b94b638145a3953da2b699", name: "Zone Settings Write", scope: "zone" },
  { id: "82e64a83756745bbbb1c9c2701bf816b", name: "DNS Read", scope: "zone" },
  { id: "4755a26eedb94da69e1066d98aa820be", name: "DNS Write", scope: "zone" },
  { id: "c03055bc037c4ea9afb9a9f104b7b721", name: "SSL and Certificates Write", scope: "zone" },
  { id: "4ec32dfcb35641c5bb32d5ef1ab963b4", name: "Firewall Services Read", scope: "zone" },
  { id: "43137f8d07884d3198dc0ee77ca6e79b", name: "Firewall Services Write", scope: "zone" },
  { id: "d8e12db741544d1586ec1d6f5d3c7786", name: "Dynamic URL Redirects Read", scope: "zone" },
  { id: "74e1036f577a48528b78d2413b40538d", name: "Dynamic URL Redirects Write", scope: "zone" },
  { id: "3245da1cf36c45c3847bb9b483c62f97", name: "Cache Settings Read", scope: "zone" },
  { id: "9ff81cbbe65c400b97d92c3c1033cab6", name: "Cache Settings Write", scope: "zone" },
  { id: "20e5ea084b2f491c86b8d8d90abff905", name: "Config Settings Read", scope: "zone" },
  { id: "06f0526e6e464647bd61b63c54935235", name: "Config Settings Write", scope: "zone" },
  { id: "211a4c0feb3e43b3a2d41f1443a433e7", name: "Zone Transform Rules Read", scope: "zone" },
  { id: "0ac90a90249747bca6b047d97f0803e9", name: "Zone Transform Rules Write", scope: "zone" },
  { id: "dbc512b354774852af2b5a5f4ba3d470", name: "Zone WAF Read", scope: "zone" },
  { id: "fb6778dc191143babbfaa57993f1d275", name: "Zone WAF Write", scope: "zone" },
  { id: "2072033d694d415a936eaeb94e6405b8", name: "Workers Routes Read", scope: "zone" },
  { id: "28f4b596e7d643029c524985477ae49a", name: "Workers Routes Write", scope: "zone" },
] as const;

/**
 * Set ID для быстрой проверки
 */
export const CF_REQUIRED_PERMISSION_IDS = new Set(
  CF_REQUIRED_PERMISSIONS.map(p => p.id)
);

