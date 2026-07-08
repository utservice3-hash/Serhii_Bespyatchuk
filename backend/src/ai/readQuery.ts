import { pool } from "../db/pool.js";

export const MAX_RESULT_ROWS = 500;

export type ReadResult =
  | { ok: true; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean }
  | { ok: false; error: string };

/**
 * Run ONE read-only statement (SELECT/WITH) with a hard timeout and row cap.
 * Used both by the AI chat tool (query_db) and by AI-built dashboard widgets,
 * so the same guardrails apply everywhere: single statement, READ ONLY tx,
 * 20s statement_timeout, row limit. Never throws — returns a tagged result.
 */
export async function runReadOnly(sql: string): Promise<ReadResult> {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) {
    return { ok: false, error: "Дозволені лише SELECT/WITH-запити" };
  }
  if (/;/.test(trimmed)) {
    return { ok: false, error: "Лише один запит за виклик (крапка з комою всередині заборонена)" };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '20s'");
    const res = await client.query(trimmed);
    await client.query("COMMIT");
    const rows = res.rows.slice(0, MAX_RESULT_ROWS) as Record<string, unknown>[];
    return { ok: true, rows, rowCount: res.rowCount ?? rows.length, truncated: (res.rowCount ?? 0) > MAX_RESULT_ROWS };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.release();
  }
}
