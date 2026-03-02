// src/api/types/worker.ts

export interface Env {
  // ===== Environment =====
  ENVIRONMENT?: 'dev' | 'production';

  // ===== KV =====
  KV_RATELIMIT: KVNamespace;     // rate limits
  KV_SESSIONS: KVNamespace;      // sessions, omni tokens, oauth state
  KV_CREDENTIALS: KVNamespace;   // encrypted API keys
  KV_RULES: KVNamespace;         // redirect rules for edge worker
  KV_TDS: KVNamespace;           // TDS compiled rules

  // ===== DB =====
  DB301: D1Database;

  // ===== Secrets =====
  MASTER_SECRET: string;
  TURNSTILE_SECRET?: string;
  TG_BOT_TOKEN?: string;
  SMS_ENDPOINT?: string;
  SMS_API_KEY?: string;
  SMS_SENDER_ID?: string;

  // ===== Cloudflare Email Routing (ВХОДЯЩИЕ: тикеты, support) =====
  EMAIL?: {
    send(options: {
      to: string;
      from: string;
      subject: string;
      text: string;
    }): Promise<void>;
  };

  // ===== Email Provider =====
  EMAIL_PROVIDER: string;        // "postal" | "mailersend"

  // ===== Postal (ИСХОДЯЩИЕ: registration, reset, notifications) =====
  POSTAL_API_URL?: string;       // "https://postal.301.st"
  POSTAL_API_KEY?: string;       // Secret: X-Server-API-Key

  // ===== MailerSend (fallback) =====
  MAILERSEND_API_TOKEN?: string; // optional — fallback provider
  MAILERSEND_API_URL?: string;   // optional — fallback provider

  EMAIL_FROM: string;
  EMAIL_FROM_NAME?: string;

  // ===== OAuth =====
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  OAUTH_REDIRECT_BASE?: string;
}

