import pg from 'pg';
import { config } from './config.ts';

pg.types.setTypeParser(20, (v) => Number(v)); // bigint -> number (audit seq, counts)
pg.types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD' as stored (no time zone shift)
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export type Db = pg.Pool | pg.PoolClient;

/** Transaction with automatic retry on deadlock / serialization failure (safe: the whole unit is replayed). */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      const code = (e as { code?: string }).code;
      if ((code === '40P01' || code === '40001') && i < attempts) { await new Promise((r) => setTimeout(r, 50 * i + Math.random() * 100)); continue; }
      throw e;
    } finally {
      c.release();
    }
  }
}

/**
 * Serialises key-lifecycle writes for one hotel. Taken first in every such transaction (and by audit()),
 * so locks are always acquired in the same order and concurrent callbacks/results cannot deadlock.
 */
export async function lockHotel(c: pg.PoolClient, hotelId: string | null) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${hotelId ?? 'platform'}`]);
}

export async function one<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await db.query(sql, params)).rows[0] as T | undefined;
}
export async function many<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}
