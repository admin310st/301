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

  // ===== Email =====
  EMAIL?: {
    send(options: {
      to: string;
      from: string;
      subject: string;
      text: string;
    }): Promise<void>;
  };
  EMAIL_FROM?: string;

  // ===== OAuth =====
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

