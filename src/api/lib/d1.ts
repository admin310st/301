// src/api/lib/d1.ts

/**
 * Минимальный  D1-клиент 
 * Обёртка вокруг env.DB301.prepare().
 */
export class D1 {
  private db: D1Database;

  constructor(env: Env) {
    this.db = env.DB301;
  }

  //  доступ к prepare
  prepare(query: string) {
    return this.db.prepare(query);
  }

  // EXEC — INSERT / UPDATE / DELETE (без возврата строк)
  async exec(query: string, ...params: any[]): Promise<void> {
    await this.db.prepare(query).bind(...params).run();
  }

  // ONE — вернуть одну строку или null
  async one<T = any>(query: string, ...params: any[]): Promise<T | null> {
    const result = await this.db.prepare(query).bind(...params).first<T>();
    return result ?? null;
  }

  // FIRST — вернуть одно значение (первой колонки)
  async first<T = any>(query: string, ...params: any[]): Promise<T | null> {
    const row = await this.db.prepare(query).bind(...params).first<any>();
    if (!row) return null;

    const key = Object.keys(row)[0];
    return row[key] as T;
  }

  // ALL — вернуть массив строк
  async all<T = any>(query: string, ...params: any[]): Promise<T[]> {
    const { results } = await this.db.prepare(query).bind(...params).all<T>();
    return results ?? [];
  }
}

/**
 * Helper function для создания экземпляра D1 клиента
 */
export function getDB(env: Env): D1 {
  return new D1(env);
}

