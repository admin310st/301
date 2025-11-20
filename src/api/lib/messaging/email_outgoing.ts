// src/api/lib/messaging/email_outgoing.ts
/**
 * MailerSend API для отправки исходящих transactional emails
 * (регистрация, сброс пароля, уведомления)
 */

import { HTTPException } from "hono/http-exception";
import { getEmailTemplate } from "./templates";
import type { SendMessageInput } from "../message_sender";

/**
 * Отправка email через MailerSend API
 */

export async function sendEmailOutgoing(
  env: Env,
  data: SendMessageInput
): Promise<void> {
  // DEV MODE: логируем и выходим ДО проверки токена
  const isDev = env.ENV_MODE === "dev" || env.WORKERS_ENV === "dev";
  
  if (isDev) {
    const template = getEmailTemplate(data.template, data.token, env);
    console.log("[EMAIL DEV MODE] Skipping real send:", {
      to: data.identifier,
      subject: template.subject,
      verify_url: `${env.OAUTH_REDIRECT_BASE}/auth/verify?token=${data.token}`
    });
    return; // Выход БЕЗ отправки
  }

  // PROD MODE: проверяем токен (он уже в secrets)
  if (!env.MAILERSEND_API_TOKEN) {
    throw new HTTPException(500, { message: "mailersend_not_configured" });
  }
  if (!env.EMAIL_FROM) {
    throw new HTTPException(500, { message: "email_from_not_configured" });
  }

  // Получаем шаблон письма
  const template = getEmailTemplate(data.template, data.token, env);

  // Формируем payload для MailerSend API
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

  // Отправка через MailerSend API
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

  console.log(`[EMAIL SENT] ${data.identifier} - ${data.template || "verify"}`);
}

