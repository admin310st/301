// src/api/lib/messaging/telegram.ts
/**
 * Telegram Bot API для отправки OTP-кодов
 */

import { HTTPException } from "hono/http-exception";
import type { SendMessageInput } from "../message_sender";

/**
 * Отправка сообщения через Telegram Bot API
 */
export async function sendTelegram(
  env: Env,
  data: SendMessageInput
): Promise<void> {
  if (!env.TG_BOT_TOKEN) {
    throw new HTTPException(500, { message: "telegram_not_configured" });
  }

  if (!data.code) {
    throw new HTTPException(500, { message: "otp_required_for_telegram" });
  }

  const apiUrl = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;
  const message = getTelegramMessage(data);

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: data.identifier,
      text: message,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("[TELEGRAM ERROR]", response.status, error);
    throw new HTTPException(500, { message: "telegram_send_failed" });
  }

  console.log(`[TELEGRAM SENT] ${data.identifier} - ${data.template || "verify"}`);
}

/**
 * Формирование текста сообщения для Telegram
 */
function getTelegramMessage(data: SendMessageInput): string {
  switch (data.template) {
    case "login":
      return `🔑 Ваш код входа: ${data.code}\n\n301.st`;

    case "reset":
      return `🔐 Код для восстановления пароля: ${data.code}\n\n301.st`;

    case "invite":
      return `👥 Вас пригласили в 301.st\nКод подтверждения: ${data.code}\n\n301.st`;

    case "action":
      return `✅ Подтверждение действия: ${data.code}\n\n301.st`;

    default:
      return `✉️ Код подтверждения: ${data.code}\n\n301.st`;
  }
}

