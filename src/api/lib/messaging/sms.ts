// src/api/lib/messaging/sms.ts
/**
 * SMS API для отправки OTP-кодов (заглушка)
 * Готово к интеграции с SMS-провайдером
 */

import { HTTPException } from "hono/http-exception";
import type { SendMessageInput } from "../message_sender";

/**
 * Отправка SMS через внешний провайдер
 */
export async function sendSms(
  env: Env,
  data: SendMessageInput
): Promise<void> {
  if (!env.SMS_ENDPOINT) {
    throw new HTTPException(500, { message: "sms_not_configured" });
  }

  if (!env.SMS_API_KEY) {
    throw new HTTPException(500, { message: "sms_api_key_missing" });
  }

  if (!data.code) {
    throw new HTTPException(400, { message: "otp_required_for_sms" });
  }

  // Формируем текст SMS
  const message = getSmsMessage(data);

  // Отправка через внешний SMS API
  const response = await fetch(env.SMS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": env.SMS_API_KEY,
    },
    body: JSON.stringify({
      to: data.identifier,
      message,
      sender: env.SMS_SENDER_ID || "301",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("[SMS ERROR]", response.status, error);
    throw new HTTPException(500, { message: "sms_send_failed" });
  }

  console.log(`[SMS SENT] ${data.identifier} - ${data.template || "verify"}`);
}

/**
 * Формирование текста SMS
 */
function getSmsMessage(data: SendMessageInput): string {
  const code = data.code;

  switch (data.template) {
    case "login":
      return `Ваш код входа 301.st: ${code}`;

    case "reset":
      return `Код восстановления 301.st: ${code}`;

    case "invite":
      return `Приглашение 301.st. Код: ${code}`;

    case "action":
      return `Подтверждение 301.st: ${code}`;

    default:
      return `Код подтверждения 301.st: ${code}`;
  }
}
