/**
 * Перевірка контрагента: запуск, хід, завершення. Запити до YouScore йдуть у фоні (кожен — до 30 с, 202 повторюється один раз),
 * браузер опитує GET /api/counterparty/checks/:id. ЄДР приходить першим (base), решта — разом (subj).
 *
 * Скільки коштує (рішення Сергія 23.10 — щоб вистачало на 300 діючих + до 100 нових):
 *   перша перевірка коду  — ЄДР + історія змін + суди + виконавчі + експрес-аналіз = 5 (ФОП: ЄДР + виконавчі + експрес = 3);
 *   повторна / планова    — без історії змін = 4: зміни власників і директора — порівнянням з попередньою перевіркою;
 *   «скільки компаній у власника» — лише для власників, яких ще не рахували (кеш cp_owner_counts — 6 місяців), +1 за кожного;
 *   PDF-досьє — до запиту на погодження (+1) або на вимогу.
 *
 * Коли перевірка завершилась:
 *   • запити «Перевіряється», що на неї чекали → «На погодженні» + подія «Перевірено в YouControl» (+ PDF-досьє до запиту);
 *   • «Перевірити заново» (Сергій) → запит отримує нову перевірку + подія «Перевірено заново».
 * Не вдалося — перевірка «failed» з текстом для людини; запит не застрягає в «Перевіряється» (іде Сергію з поміткою).
 */
import type { Pool } from 'pg';
import { isFopCode } from '../shared/counterparty.js';
import { checkSummary, type CheckSrc, type CpCheck } from '../shared/cpCheck.js';
import { dt } from '../shared/cpFormat.js';
import { addEvent, getCheck, latestDone, toCheck, tx } from './cpStore.js';
import { afterCheck } from './limitFindings.js';
import type { FileStore } from './fileStore.js';
import { HttpError } from './cpRoles.js';
import { YouScoreError, type Meter, type YouScoreApi } from './youscore/client.js';
import { baseFromUsr, mergeOwnership, ownerKey, ownersToCount, subjectFrom, type OwnerCounts } from './youscore/parse.js';

export interface CheckRunnerOptions {
  pool: Pool;
  youscore: YouScoreApi | null;
  files: FileStore;
  now?: () => Date;
  /** Скільки власників рахувати на «скільки компаній у власника» (кожен новий — +1 транзакція). 0 — не рахувати. */
  ownerLookups?: number;
}
type RunSrc = Exclude<CheckSrc, 'monitor'>;
export interface CheckRunner {
  /** Запустити й одразу повернути (браузер опитує). */
  start(code: string, by: { id: string; name: string } | null, src: RunSrc): Promise<CpCheck>;
  /** Запустити й дочекатися результату (планові перевірки — по одній, без піку запитів). */
  runNow(code: string, by: { id: string; name: string } | null, src: RunSrc): Promise<CpCheck>;
  /** PDF-досьє до перевірки (якщо ще немає). +1 транзакція. */
  pdfFor(checkId: string): Promise<boolean>;
  /** Перевірка завершилась → запити, що на неї чекали (idempotent; викликати після прив'язки запиту, щоб не проґавити гонку). */
  settle(checkId: string): Promise<void>;
  /** Дочекатися всіх фонових перевірок (тести, коректна зупинка сервера). */
  idle(): Promise<void>;
}

/** «Збережена перевірка від 10.09 — Олег Ткачук. Усі критерії пройдено». */
export function checkedNote(c: CpCheck, saved: boolean, now: Date): string {
  if (c.status === 'failed') return `Перевірку YouControl не завершено: ${c.error || 'помилка'} — Сергій може «Перевірити заново».`;
  const s = c.subj ? checkSummary(c.subj, now) : '';
  return (saved ? `Збережена перевірка від ${dt(c.at)} — ${c.byName || 'система'}. ` : '') + s;
}

export function checkRunner(o: CheckRunnerOptions): CheckRunner {
  const { pool } = o;
  const now = o.now || (() => new Date());
  const lookups = o.ownerLookups ?? 4;
  const inflight = new Set<Promise<unknown>>();
  const bg = <T>(p: Promise<T>) => {
    const q = p.catch(e => { console.error('[counterparty] перевірка:', e instanceof Error ? e.message : e); return undefined; }).finally(() => inflight.delete(q));
    inflight.add(q);
    return q;
  };

  async function fail(id: string, msg: string, m: Meter) {
    await pool.query("UPDATE cp_checks SET status = 'failed', error = $2, tx = $3, done_at = now() WHERE id = $1", [id, msg, m.tx]);
  }

  /** «Скільки компаній у власника»: попередня перевірка → кеш (6 міс.) → YouScore (+1). */
  async function ownerCounts(usr: unknown, prevOwners: Map<string, number | null>, m: Meter): Promise<OwnerCounts> {
    const counts: OwnerCounts = new Map();
    if (lookups <= 0 || !o.youscore) return counts;
    for (const x of ownersToCount(usr, lookups)) {
      const prev = prevOwners.get(x.key);
      if (prev !== undefined && prev !== null) { counts.set(x.key, prev); continue; }
      const cached = (await pool.query("SELECT companies FROM cp_owner_counts WHERE key = $1 AND at > now() - interval '6 months'", [x.key])).rows[0];
      if (cached) { counts.set(x.key, cached.companies); continue; }
      const n = x.kind === 'person' ? await o.youscore.personCompanies(x.name, m).catch(() => null) : await o.youscore.companyCompanies(x.code!, m).catch(() => null);
      counts.set(x.key, n);
      if (n !== null) await pool.query('INSERT INTO cp_owner_counts (key, companies, at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET companies = EXCLUDED.companies, at = now()', [x.key, n]);
    }
    return counts;
  }

  /** Перевірка завершилась (успішно чи ні) → запити, що на неї чекали. */
  async function settle(id: string) {
    const c = await getCheck(pool, id);
    if (!c || c.status === 'running') return;
    const n = now();
    const attached = await tx(pool, async db => {
      let any = false;
      const waiting = await db.query("SELECT id, check_saved FROM cp_requests WHERE status = 'checking' AND check_id = $1 FOR UPDATE", [id]);
      for (const r of waiting.rows) {
        await db.query("UPDATE cp_requests SET status = 'pending', updated_at = now() WHERE id = $1", [r.id]);
        await addEvent(db, r.id, 'checked', null, checkedNote(c, !!r.check_saved, n));
        any = true;
      }
      const re = await db.query('SELECT id FROM cp_requests WHERE recheck_id = $1 FOR UPDATE', [id]);
      for (const r of re.rows) {
        if (c.status === 'done') {
          await db.query('UPDATE cp_requests SET check_id = $2, check_saved = false, recheck_id = NULL, updated_at = now() WHERE id = $1', [r.id, id]);
          await addEvent(db, r.id, 'rechecked', c.by ? { id: c.by, name: c.byName || '' } : null, checkedNote(c, false, n));
          any = true;
        } else {
          await db.query('UPDATE cp_requests SET recheck_id = NULL, updated_at = now() WHERE id = $1', [r.id]);
          await addEvent(db, r.id, 'rechecked', c.by ? { id: c.by, name: c.byName || '' } : null, `Повторна перевірка не вдалася: ${c.error || 'помилка'}. Діє попередня.`);
        }
      }
      return any;
    });
    if (attached && c.status === 'done' && !c.pdf) void bg(pdfFor(id));
  }

  async function run(id: string, code: string) {
    const ys = o.youscore!;
    const m: Meter = { tx: 0 };
    try {
      const prev = await latestDone(pool, code);                     // була перевірка → повторна, дешевша
      const repeat = !!prev?.subj;
      const u = await ys.usr(code, m);
      if (!u.data) { await fail(id, `У ЄДР немає ${isFopCode(code) ? 'ФОП з ІПН' : 'компанії з кодом'} ${code}. Перевірте цифри.`, m); return; }
      const base = baseFromUsr(code, u.data);
      await pool.query('UPDATE cp_checks SET base = $2, tx = $3 WHERE id = $1', [id, JSON.stringify(base), m.tx]);
      const fop = base.fop;
      const [h, courts, enf, ea] = await Promise.all([
        fop || repeat ? null : ys.history(code, m).catch(() => null),  // історія — лише першого разу
        fop ? null : ys.courtCaseGroups(code, m, 2),                   // суди — обов'язково (ФОП — вручну)
        ys.enforcement(code, m),
        ys.expressAnalysis(code, m).catch(() => null),
      ]);
      const prevOwners = new Map((prev?.subj?.own?.owners || []).map(x => [ownerKey(x), x.companies] as [string, number | null]));
      const counts = fop ? new Map() : await ownerCounts(u.data, prevOwners, m);
      const archived = [u, h, courts, enf, ea].some(g => !!g && g.archived);
      const at = now();
      const subj = subjectFrom(code, { usr: u.data, history: h?.data ?? null, courts: courts?.data ?? null, enforcement: enf?.data ?? null, express: ea?.data ?? null }, counts, at, archived);
      if (repeat && prev?.subj?.own) subj.own = mergeOwnership(prev.subj.own, subj.own, prev.at, at);
      await pool.query("UPDATE cp_checks SET status = 'done', subj = $2, tx = $3, done_at = now() WHERE id = $1", [id, JSON.stringify(subj), m.tx]);
      // клієнт з лімітом: нова справа → призупинення, інші зміни → позначка (для решти — нічого)
      try { await afterCheck(pool, (await getCheck(pool, id))!, prev, at); } catch (e) { console.error('[counterparty] ліміт після перевірки:', e instanceof Error ? e.message : e); }
    } catch (e) {
      await fail(id, e instanceof YouScoreError ? e.message : 'Не вдалося перевірити — спробуйте ще раз.', m);
      if (!(e instanceof YouScoreError)) console.error('[counterparty] перевірка', code, e);
    }
    await settle(id);
  }

  async function pdfFor(checkId: string): Promise<boolean> {
    const c = await getCheck(pool, checkId);
    if (!c || c.status !== 'done') return false;
    if (c.pdf) return true;
    if (!o.youscore) throw new HttpError(503, 'Перевірка YouControl не налаштована: на сервері немає YOUSCORE_API_KEY.');
    const m: Meter = { tx: 0 };
    const f = await o.youscore.pdf(c.code, m);
    if (!f) { await pool.query('UPDATE cp_checks SET tx = tx + $2 WHERE id = $1', [checkId, m.tx]); return false; }
    const key = await o.files.put(f.bytes, { name: `YouControl_${c.code}.pdf`, mime: f.mime });
    await pool.query('UPDATE cp_checks SET pdf_key = COALESCE(pdf_key, $2), tx = tx + $3 WHERE id = $1', [checkId, key, m.tx]);
    return true;
  }

  async function insert(code: string, by: { id: string; name: string } | null, src: RunSrc) {
    if (!o.youscore) throw new HttpError(503, 'Перевірка YouControl не налаштована: на сервері немає YOUSCORE_API_KEY.');
    const ins = await pool.query('INSERT INTO cp_checks (code, src, created_by, created_by_name) VALUES ($1, $2, $3, $4) RETURNING *', [code, src, by ? by.id : null, by ? by.name : null]);
    return toCheck(ins.rows[0]);
  }

  return {
    async start(code, by, src) {
      const c = await insert(code, by, src);
      void bg(run(c.id, code));
      return c;
    },
    async runNow(code, by, src) {
      const c = await insert(code, by, src);
      await bg(run(c.id, code));
      return (await getCheck(pool, c.id))!;
    },
    pdfFor,
    settle,
    async idle() { while (inflight.size) await Promise.all([...inflight]); },
  };
}
