// src/api/lib/messaging/email_outgoing.ts
/**
 * Email sending via Postal or MailerSend
 * Routing controlled by EMAIL_PROVIDER env var
 */

import { HTTPException } from "hono/http-exception";
import { getEmailTemplate } from "./templates";
import type { SendMessageInput } from "../message_sender";

/**
 * Отправка email — роутинг по EMAIL_PROVIDER
 */
export async function sendEmailOutgoing(
  env: Env,
  data: SendMessageInput
): Promise<void> {
  // DEV MODE: логируем и выходим ДО проверки токена
  const isDev = env.ENV_MODE === "dev" || env.WORKERS_ENV === "dev";

  if (isDev) {
    const lang = data.lang || "en";
    const template = getEmailTemplate(data.template, data.token, env, lang, data.origin);
    console.log("[EMAIL DEV MODE] Skipping real send:", {
      to: data.identifier,
      subject: template.subject,
      lang,
      verify_url: `${env.OAUTH_REDIRECT_BASE}/auth/verify?token=${data.token}`
    });
    return; // Выход БЕЗ отправки
  }

  // PROD MODE: роутинг по провайдеру
  if (env.EMAIL_PROVIDER === "postal") {
    return await sendViaPostal(env, data);
  } else if (env.EMAIL_PROVIDER === "mailersend") {
    return await sendViaMailerSend(env, data);
  } else {
    throw new HTTPException(500, {
      message: `unknown email provider: ${env.EMAIL_PROVIDER}`,
    });
  }
}

/**
 * Отправка через Postal API
 */
async function sendViaPostal(
  env: Env,
  data: SendMessageInput
): Promise<void> {
  if (!env.POSTAL_API_URL) {
    throw new HTTPException(500, { message: "postal_api_url_not_configured" });
  }
  if (!env.POSTAL_API_KEY) {
    throw new HTTPException(500, { message: "postal_api_key_not_configured" });
  }
  if (!env.EMAIL_FROM) {
    throw new HTTPException(500, { message: "email_from_not_configured" });
  }

  const origin = data.origin;
  const lang = data.lang || "en";
  const template = getEmailTemplate(data.template, data.token, env, lang, origin);

  const payload = {
    to: [data.identifier],
    from: `${env.EMAIL_FROM_NAME || "301.st"} <${env.EMAIL_FROM}>`,
    subject: template.subject,
    html_body: template.html,
    plain_body: template.text,
  };

  const response = await fetch(`${env.POSTAL_API_URL}/api/v1/send/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Server-API-Key": env.POSTAL_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("[POSTAL ERROR]", response.status, error);
    throw new HTTPException(500, {
      message: "email_send_failed",
      details: error,
    } as any);
  }

  console.log(`[EMAIL SENT via postal] ${data.identifier} - ${data.template || "verify"}`);
}

/**
 * Отправка через MailerSend API
 */
async function sendViaMailerSend(
  env: Env,
  data: SendMessageInput
): Promise<void> {
  if (!env.MAILERSEND_API_TOKEN) {
    throw new HTTPException(500, { message: "mailersend_not_configured" });
  }
  if (!env.EMAIL_FROM) {
    throw new HTTPException(500, { message: "email_from_not_configured" });
  }

  const origin = data.origin;
  const lang = data.lang || "en";
  const template = getEmailTemplate(data.template, data.token, env, lang, origin);

  const payload = {
    from: {
      email: env.EMAIL_FROM,
      name: env.EMAIL_FROM_NAME || "301.st",
    },
    to: [
      {
        email: data.identifier,
      },
    ],
    subject: template.subject,
    text: template.text,
    html: template.html,
  };

  const response = await fetch(`${env.MAILERSEND_API_URL}/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.MAILERSEND_API_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("[MAILERSEND ERROR]", response.status, error);
    throw new HTTPException(500, {
      message: "email_send_failed",
      details: error,
    } as any);
  }

  console.log(`[EMAIL SENT via mailersend] ${data.identifier} - ${data.template || "verify"}`);
}
