/**
 * 💼 ДЖОБА: ВІДГУКИ З WORK.UA (28.09.2026, прохід 7). Раз на 15 хв бере нові відгуки порціями по 50 (від нових
 * до старих, `before_id`) і зупиняється на вже обробленому id. Перший запуск — назад на 14 днів.
 *
 * 🔴 БЕЗ ЛОГІНА — ЧЕСНИЙ ПРОПУСК, А НЕ «НУЛЬ ВІДГУКІВ» (той самий принцип, що в tl;dv): порожньо і «немає
 * доступу» — різні стани. Пул і `jobRuns` імпортуються ліниво: `db/pool.js` кидає на відсутньому
 * `DATABASE_URL` ще на імпорті, і тоді пропуск падав би помилкою оточення.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { JobSkip } from "./jobRuns.js";
import { workuaUrl, workuaHeaders, parseResponses, parseJobs, WORKUA_BACKFILL_DAYS, type WorkuaResponse, type WorkuaJob } from "../core/workua.js";
import type { Db } from "../core/secrets.js";

export interface WorkuaStatus { configured: boolean; lastRunAt: string | null; lastError: string | null; lastBatch: { created: number; repeat: number; files: number } | null }
const status: WorkuaStatus = { configured: false, lastRunAt: null, lastError: null, lastBatch: null };
export const getWorkuaStatus = (): WorkuaStatus => ({ ...status, configured: !!(process.env.WORKUA_LOGIN && process.env.WORKUA_PASSWORD) });

const creds = () => (process.env.WORKUA_LOGIN && process.env.WORKUA_PASSWORD ? workuaHeaders(process.env.WORKUA_LOGIN, process.env.WORKUA_PASSWORD) : null);
/** Скільки порцій максимум за прогін: 14 днів × ~30 відгуків/день ≈ 9 порцій; стеля від нескінченного циклу. */
const MAX_PAGES = 20;

async function get(p: string, h: Record<string, string>): Promise<Response> {
  const res = await fetch(workuaUrl(p), { headers: h });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    status.lastError = `work.ua ${res.status}`;
    throw new Error(`work.ua ${res.status}: ${res.status === 401 ? "невірний логін або пароль" : res.status === 403 ? "користувача заблоковано" : "забагато спроб входу"}`);
  }
  return res;
}

/** Нові відгуки: від найсвіжіших назад, поки не дійдемо до вже обробленого id або межі 14 днів. */
export async function fetchNewResponses(h: Record<string, string>, lastId: number | null, now = Date.now()): Promise<WorkuaResponse[]> {
  const floor = now - WORKUA_BACKFILL_DAYS * 86_400_000;
  const out: WorkuaResponse[] = [];
  let before: number | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await get(`/jobs/responses?limit=50&sort=0${before ? `&before_id=${before}` : ""}`, h);
    if (res.status === 404) break;                        // «відгуків за заданими параметрами немає»
    if (!res.ok) throw new Error(`work.ua /jobs/responses ${res.status}`);
    const items = parseResponses(await res.json());
    if (!items.length) break;
    let stop = false;
    for (const r of items) {
      if (lastId != null && r.id <= lastId) { stop = true; break; }
      if (lastId == null && r.date && Date.parse(r.date) < floor) { stop = true; break; }
      out.push(r);
    }
    if (stop) break;
    before = Math.min(...items.map((r) => r.id));
  }
  return out;
}

export async function fetchWorkuaJobs(): Promise<WorkuaJob[] | null> {
  const h = creds();
  if (!h) return null;
  const res = await get(`/jobs/my?all=1`, h);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`work.ua /jobs/my ${res.status}`);
  return parseJobs(await res.json());
}

export async function syncWorkua() {
  const h = creds();
  if (!h) return { skipped: true, reason: "немає WORKUA_LOGIN / WORKUA_PASSWORD — відгуки з work.ua не забираємо" } satisfies JobSkip;
  const { pool } = await import("../db/pool.js");
  const { absorbResponses, lastResponseId } = await import("../core/workuaStore.js");
  const { UPLOAD_DIR } = await import("../routes/uploads.js");
  const db = pool as unknown as Db;
  const fresh = await fetchNewResponses(h, await lastResponseId(db));
  const docs = path.join(UPLOAD_DIR, "..", "documents"); // та сама тека, що файли кандидатів, під нічним бекапом
  const { hiringStoredName } = await import("../core/hiringRules.js");
  const out = await absorbResponses(db, fresh, {
    fetch: async (r) => {
      if (r.jobId == null) return null;
      const res = await get(`/response_files/${r.jobId}/${r.id}`, h);
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    },
    store: async (buf, mime) => {
      const name = hiringStoredName(randomUUID(), mime);
      await mkdir(docs, { recursive: true });
      await writeFile(path.join(docs, name), buf);
      return name;
    },
  });
  Object.assign(status, { lastRunAt: new Date().toISOString(), lastError: null, lastBatch: { created: out.created, repeat: out.repeat, files: out.files } });
  return out;
}
