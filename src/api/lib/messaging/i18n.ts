// src/api/lib/messaging/i18n.ts
/**
 * i18n для email шаблонов
 * Плоская структура ключей: {lang}:{module}:{type}:{key}
 *
 * TODO: Позже перенести в KV Storage для изменения без редеплоя
 */

const messages: Record<string, string> = {
  // === VERIFY ===
  "ru:email:verify:subject":   "Подтверждение email — 301.st",
  "ru:email:verify:title":     "Подтвердите ваш email",
  "ru:email:verify:welcome":   "Добро пожаловать в 301.st!",
  "ru:email:verify:body":      "Нажмите кнопку ниже, чтобы подтвердить ваш email и активировать аккаунт:",
  "ru:email:verify:button":    "Подтвердить email",
  "ru:email:verify:link_hint": "Или скопируйте эту ссылку в браузер:",
  "ru:email:verify:expires":   "Ссылка действительна 15 минут.",
  "ru:email:verify:ignore":    "Если вы не регистрировались на 301.st, проигнорируйте это письмо.",

  "en:email:verify:subject":   "Confirm your email — 301.st",
  "en:email:verify:title":     "Confirm your email",
  "en:email:verify:welcome":   "Welcome to 301.st!",
  "en:email:verify:body":      "Click the button below to confirm your email and activate your account:",
  "en:email:verify:button":    "Confirm email",
  "en:email:verify:link_hint": "Or copy this link to your browser:",
  "en:email:verify:expires":   "This link is valid for 15 minutes.",
  "en:email:verify:ignore":    "If you didn't sign up for 301.st, please ignore this email.",

  // === RESET ===
  "ru:email:reset:subject":    "Восстановление пароля — 301.st",
  "ru:email:reset:title":      "Восстановление пароля",
  "ru:email:reset:body":       "Вы запросили восстановление пароля. Нажмите кнопку ниже:",
  "ru:email:reset:button":     "Восстановить пароль",
  "ru:email:reset:link_hint":  "Или скопируйте эту ссылку в браузер:",
  "ru:email:reset:expires":    "Ссылка действительна 15 минут.",
  "ru:email:reset:ignore":     "Если вы не запрашивали восстановление, проигнорируйте это письмо.",

  "en:email:reset:subject":    "Reset your password — 301.st",
  "en:email:reset:title":      "Reset password",
  "en:email:reset:body":       "You requested a password reset. Click the button below:",
  "en:email:reset:button":     "Reset password",
  "en:email:reset:link_hint":  "Or copy this link to your browser:",
  "en:email:reset:expires":    "This link is valid for 15 minutes.",
  "en:email:reset:ignore":     "If you didn't request this, please ignore this email.",

  // === LOGIN ===
  "ru:email:login:subject":    "Вход в аккаунт — 301.st",
  "ru:email:login:title":      "Подтверждение входа",
  "ru:email:login:body":       "Для входа в ваш аккаунт нажмите кнопку ниже:",
  "ru:email:login:button":     "Войти в аккаунт",
  "ru:email:login:link_hint":  "Или скопируйте эту ссылку в браузер:",
  "ru:email:login:expires":    "Ссылка действительна 15 минут.",

  "en:email:login:subject":    "Sign in to your account — 301.st",
  "en:email:login:title":      "Confirm sign in",
  "en:email:login:body":       "Click the button below to sign in to your account:",
  "en:email:login:button":     "Sign in",
  "en:email:login:link_hint":  "Or copy this link to your browser:",
  "en:email:login:expires":    "This link is valid for 15 minutes.",

  // === INVITE ===
  "ru:email:invite:subject":   "Приглашение в команду — 301.st",
  "ru:email:invite:title":     "Приглашение в команду",
  "ru:email:invite:body":      "Вас пригласили присоединиться к аккаунту 301.st:",
  "ru:email:invite:button":    "Принять приглашение",
  "ru:email:invite:link_hint": "Или скопируйте эту ссылку в браузер:",
  "ru:email:invite:expires":   "Ссылка действительна 15 минут.",

  "en:email:invite:subject":   "Team invitation — 301.st",
  "en:email:invite:title":     "Team invitation",
  "en:email:invite:body":      "You've been invited to join a 301.st account:",
  "en:email:invite:button":    "Accept invitation",
  "en:email:invite:link_hint": "Or copy this link to your browser:",
  "en:email:invite:expires":   "This link is valid for 15 minutes.",

  // === ACTION ===
  "ru:email:action:subject":   "Подтверждение действия — 301.st",
  "ru:email:action:title":     "Подтверждение действия",
  "ru:email:action:body":      "Для подтверждения действия нажмите кнопку ниже:",
  "ru:email:action:button":    "Подтвердить",
  "ru:email:action:link_hint": "Или скопируйте эту ссылку в браузер:",
  "ru:email:action:expires":   "Ссылка действительна 15 минут.",

  "en:email:action:subject":   "Confirm action — 301.st",
  "en:email:action:title":     "Confirm action",
  "en:email:action:body":      "Click the button below to confirm this action:",
  "en:email:action:button":    "Confirm",
  "en:email:action:link_hint": "Or copy this link to your browser:",
  "en:email:action:expires":   "This link is valid for 15 minutes.",

  // === COMMON ===
  "ru:email:common:footer":    "© 2025 301.st — Domain & Traffic Management Platform",
  "en:email:common:footer":    "© 2025 301.st — Domain & Traffic Management Platform",
};

export type Lang = "ru" | "en";

/**
 * Получить перевод по ключу
 * @param key - полный ключ "ru:email:verify:subject" или короткий "email:verify:subject"
 * @param lang - язык (если ключ короткий)
 */
export function t(key: string, lang?: Lang): string {
  // Если ключ уже содержит язык
  if (key.startsWith("ru:") || key.startsWith("en:")) {
    return messages[key] || `[${key}]`;
  }

  // Иначе добавляем язык
  const fullKey = `${lang || "en"}:${key}`;
  const fallbackKey = `en:${key}`;

  return messages[fullKey] || messages[fallbackKey] || `[${key}]`;
}

/**
 * Определить язык из Accept-Language header
 */
export function detectLang(acceptLang: string | null | undefined): Lang {
  if (!acceptLang) return "en";
  const supported: Lang[] = ["ru", "en"];
  const langs = acceptLang.split(",").map(l => l.split(";")[0].trim().slice(0, 2));
  for (const lang of langs) {
    if (supported.includes(lang as Lang)) return lang as Lang;
  }
  return "en";
}
