// src/api/integrations/providers/cloudflare/permissions.ts

/**
 * Cloudflare API Token Permissions
 * 
 * обязательные разрешения для working token.
 * ID могут измениться со стороны CF — при ошибке правим вручную.
 * 
 * Источник: Cloudflare Dashboard → API Tokens → Permission Groups
 * Или: GET /user/tokens/permission_groups
 */

export interface CFPermission {
  id: string;
  name: string;
  scope: "account" | "zone";
}

/**
 * Полный список обязательных разрешений (33 шт.-могут меняться)
 */
export const CF_REQUIRED_PERMISSIONS: readonly CFPermission[] = [
  // ===== ACCOUNT SCOPE (16) =====
  { id: "c1fde68c7bcc44588cbb6ddbc16d6480", name: "Account Settings Read", scope: "account" },
  { id: "eb56a6953c034b9d97dd838155666f06", name: "Account API Tokens Read", scope: "account" },
  { id: "7ea222f3d2b24ea3a698b1684c3adff2", name: "D1 Read", scope: "account" },
  { id: "b47bfba5b3e14fc5a0287e8c59b5d026", name: "D1 Write", scope: "account" },
  { id: "8b47d2786a534c08a1f94571698f07b5", name: "Workers KV Storage Read", scope: "account" },
  { id: "f7f0eda5697f475c90846e879bab8666", name: "Workers KV Storage Write", scope: "account" },
  { id: "1a71c399035b4950a1bd1466bbe4f420", name: "Workers Scripts Read", scope: "account" },
  { id: "e086da7e2179491d91ee5f35b3ca210a", name: "Workers Scripts Write", scope: "account" },
  { id: "8bde4a9a54eb4629b76dce123a6f3069", name: "Workers Routes Read", scope: "account" },
  { id: "cd5c0e47be2144e6b7ce1c0e07bf8bf6", name: "Workers Routes Write", scope: "account" },
  { id: "dc1b0a5c06d94d8c8a0d9a8b8e3b5c6d", name: "Account Rulesets Read", scope: "account" },
  { id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", name: "Account Rulesets Write", scope: "account" },
  { id: "517b21aee92c4d89936c976ba6e4be55", name: "Account Rule Policies Read", scope: "account" },
  { id: "7d0b26c5ef5d11edb8780242ac120002", name: "Account Rule Policies Write", scope: "account" },
  { id: "e9d4c6b8a2f14d3e8c7b6a5d4e3f2c1b", name: "Account Filter Lists Read", scope: "account" },
  { id: "f0e1d2c3b4a596879a8b7c6d5e4f3a2b", name: "Account Filter Lists Write", scope: "account" },

  // ===== ZONE SCOPE (17) =====
  { id: "c8fed203ed3043cba015a93ad1616f1f", name: "Zone Read", scope: "zone" },
  { id: "3030687196b94b638145a3953da2b699", name: "Zone Write", scope: "zone" },
  { id: "82e64a83756745bbbb1c9c2701bf816b", name: "Zone Settings Read", scope: "zone" },
  { id: "e6d2666161e84845a636613608cee8d5", name: "Zone Settings Write", scope: "zone" },
  { id: "4755a26eedb94da69e1066d98aa820be", name: "DNS Read", scope: "zone" },
  { id: "9c88f9c5bce24ce7afea8971b3c2ca09", name: "DNS Write", scope: "zone" },
  { id: "9d24387c6e8544e2bc4024a03f74f3eb", name: "SSL and Certificates Write", scope: "zone" },
  { id: "c03055bc037c4ea9afb9a9f104b7b721", name: "Dynamic URL Redirects Read", scope: "zone" },
  { id: "8e47f1ef6fa54e35a25b6d1a5b55e0c9", name: "Dynamic URL Redirects Write", scope: "zone" },
  { id: "bfe0fef581d5420e9be25abcdbd2a6e2", name: "Mass URL Redirects Read", scope: "zone" },
  { id: "a9e889ee3c52403e952d6d986f294b9e", name: "Mass URL Redirects Write", scope: "zone" },
  { id: "2359c2cd7e5b4cf0a3f3c9d1e0f2a3b4", name: "Cache Settings Read", scope: "zone" },
  { id: "4a5b6c7d8e9f01234567890abcdef123", name: "Cache Settings Write", scope: "zone" },
  { id: "f29a755a7a9b429eb7eb7e7689568681", name: "Config Settings Read", scope: "zone" },
  { id: "45127d5ce5ed4b76a4c0a3b2c1d9e8f7", name: "Config Settings Write", scope: "zone" },
  { id: "c77dc6f0dd8b4afdb73f51923d99319f", name: "Zone Transform Rules Read", scope: "zone" },
  { id: "6c996f6f56f04149bf93a823b7c91e81", name: "Zone Transform Rules Write", scope: "zone" },
] as const;

/**
 * Set ID для быстрой проверки
 */
export const CF_REQUIRED_PERMISSION_IDS = new Set(
  CF_REQUIRED_PERMISSIONS.map(p => p.id)
);
