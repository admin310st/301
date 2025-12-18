// src/api/lib/retry.ts

/**
 * Retry с exponential backoff
 *
 * Используется для D1 операций, которые могут временно падать.
 * НЕ использовать для External API (CF, Namecheap) — там Fail Fast.
 *
 * @param fn - функция для выполнения
 * @param attempts - количество попыток (default: 3)
 * @param backoffMs - начальная задержка в ms (default: 100)
 * @returns результат функции
 * @throws последняя ошибка после всех попыток
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number = 3,
  backoffMs: number = 100
): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;

      // Логируем попытку (кроме последней)
      if (i < attempts - 1) {
        const delay = backoffMs * (i + 1);
        console.warn(`Retry attempt ${i + 1}/${attempts} failed, waiting ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  // Все попытки исчерпаны
  console.error(`All ${attempts} retry attempts failed`);
  throw lastError;
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
