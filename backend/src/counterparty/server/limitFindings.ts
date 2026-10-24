/**
 * Що робити зі свіжими даними YouControl по клієнту з лімітом (планова перевірка, щомісячні суди, ручна перевірка):
 *   нова справа за перевезення, клієнт — відповідач → призупинення (req — погодження в запиті; debt / set — сам ліміт);
 *   інші зміни (власники, директор, виконавчі, «особлива увага» в експрес-аналізі, стан у ЄДР) → позначка «зміни в YouControl»
 *   на 30 днів, без призупинення.
 * «Нова» справа = її ще не бачили (cl_court_seen) і немає в попередній перевірці; для юрособи без бази — лише ті, що надійшли після дати ліміту.
 */
import type { Pool } from 'pg';
import type { ClientLimit } from '../shared/clientLimits.js';
import { changesSince, type CheckSubject, type CourtCase, type CpCheck } from '../shared/cpCheck.js';
import { dt, nf } from '../shared/cpFormat.js';
import { addEvent, getCheck, getRequest, tx } from './cpStore.js';
import { addLimitEvent, limitsByMember, markCourtsSeen } from './limitsStore.js';

const caseLine = (c: CourtCase) => `${c.no}, клієнт — відповідач${c.sum ? `, ${nf(c.sum)} грн` : ''}${c.next ? `, засідання ${dt(c.next)}` : ''}`;
export function flagText(cases: CourtCase[], member: { code: string; name: string } | null, source = 'Щомісячна перевірка') {
  const who = member ? ` (юрособа ${member.name}, ${member.code})` : '';
  return cases.length === 1
    ? `${source} знайшла нову справу за перевезення: ${caseLine(cases[0])}${who}.`
    : `${source} знайшла нові справи за перевезення${who}: ${cases.map(caseLine).join('; ')}.`;
}

/** Нові справи серед знайдених: не бачили раніше, немає в попередній перевірці; без бази — лише після дати ліміту. */
export async function newCases(pool: Pool, code: string, cases: CourtCase[], prevCases: CourtCase[] | null, since: number): Promise<CourtCase[]> {
  const seen = new Set((await pool.query('SELECT case_no FROM cl_court_seen WHERE code = $1', [code])).rows.map((x: { case_no: string }) => x.case_no));
  const prevNos = new Set((prevCases || []).map(c => c.no));
  const based = seen.has('*') || !!prevCases;
  return cases.filter(c => !seen.has(c.no) && !prevNos.has(c.no) && (based || (!!c.date && Date.parse(c.date) >= since)));
}

/**
 * Призупинити через нову справу. req — запит знову «На погодженні» з позначкою (рішення за Сергієм); debt / set — позначка на ліміті.
 * checkId — перевірка, де ці справи вже є (планова / ручна); немає — створюємо «щомісячну» з попереднього результату + нових справ.
 */
export async function flagLimit(pool: Pool, l: ClientLimit, code: string, cases: CourtCase[], now: Date, o: { checkId?: string; source?: string } = {}): Promise<boolean> {
  const member = l.members.length > 1 ? l.members.find(m => m.code === code) || null : null;
  const fl = { at: now.toISOString(), what: flagText(cases, member, o.source), caseNo: cases[0].no };
  const note = `${o.source || 'Щомісячна перевірка'}: ${cases.map(c => `справа ${c.no}${c.subj ? ' — ' + c.subj : ''}`).join('; ')}, клієнт — відповідач.`;
  if (l.src === 'req' && l.requestId) {
    const r = await getRequest(pool, l.requestId);
    if (!r || r.status !== 'approved') return false;
    let subj: CheckSubject | null = null, base = null;
    if (!o.checkId) {
      const prev: CpCheck | null = r.checkId ? await getCheck(pool, r.checkId) : null;
      if (prev?.subj) {
        base = prev.base;
        subj = { ...prev.subj, yc: { ...prev.subj.yc, checkedAt: now.toISOString(),
          cases: [...cases.map(c => ({ ...c, fresh: true })), ...prev.subj.yc.cases.filter(c => !cases.some(n => n.no === c.no)).map(c => ({ ...c, fresh: false }))] } };
      }
    }
    const done = await tx(pool, async db => {
      const cur = (await db.query('SELECT status FROM cp_requests WHERE id = $1 FOR UPDATE', [r.id])).rows[0];
      if (!cur || cur.status !== 'approved') return false;
      let checkId = o.checkId || r.checkId;
      if (subj) {
        const ins = await db.query("INSERT INTO cp_checks (code, src, status, base, subj, tx, done_at) VALUES ($1, 'monitor', 'done', $2, $3, 0, now()) RETURNING id",
          [r.code, JSON.stringify(base), JSON.stringify(subj)]);
        checkId = String(ins.rows[0].id);
      }
      await db.query("UPDATE cp_requests SET status = 'pending', flag = $2, check_id = $3, updated_at = now() WHERE id = $1", [r.id, JSON.stringify(fl), checkId]);
      await addEvent(db, r.id, 'suspended', null, note, { cases: cases.map(c => c.no) });
      return true;
    });
    return done;
  }
  if (l.flag) return false;
  await tx(pool, async db => {
    await db.query('UPDATE client_limits SET flag = $2, updated_at = now() WHERE id = $1 AND flag IS NULL', [l.id, JSON.stringify(fl)]);
    await addLimitEvent(db, l.id, 'limSuspended', null, note.replace(/^[^:]+: с/, 'С'), { cases: cases.map(c => c.no) });
  });
  return true;
}

/**
 * Свіжа перевірка (не щомісячна) клієнта з лімітом: нові справи → призупинення; інші зміни → позначка; запис в історії ліміту.
 * prev — попередня завершена перевірка цього коду (до цієї). planned — чи це планова (для підпису в історії).
 */
export async function afterCheck(pool: Pool, c: CpCheck, prev: CpCheck | null, now: Date): Promise<{ flagged: number; changes: string[] }> {
  if (c.status !== 'done' || !c.subj) return { flagged: 0, changes: [] };
  const limits = await limitsByMember(pool, c.code, now);
  if (!limits.length) return { flagged: 0, changes: [] };
  const subj = c.subj;
  const since = Math.min(...limits.map(l => Date.parse(l.at)));
  const fresh = subj.fop ? [] : await newCases(pool, c.code, subj.yc.cases, prev?.subj ? prev.subj.yc.cases : null, since);
  await markCourtsSeen(pool, c.code, subj.yc.cases.map(x => x.no));
  if (fresh.length) {
    subj.yc.cases = subj.yc.cases.map(x => ({ ...x, fresh: fresh.some(f => f.no === x.no) }));
    await pool.query('UPDATE cp_checks SET subj = $2 WHERE id = $1', [c.id, JSON.stringify(subj)]);
  }
  const changes = changesSince(prev?.subj || null, subj, now);
  const source = c.src === 'planned' ? 'Планова перевірка' : 'Перевірка YouControl';
  let flagged = 0;
  for (const l of limits) {
    if (fresh.length && await flagLimit(pool, l, c.code, fresh, now, { checkId: c.id, source })) flagged++;
    else if (l.src === 'req' && l.requestId) await pool.query("UPDATE cp_requests SET check_id = $2 WHERE id = $1 AND status = 'approved'", [l.requestId, c.id]);
    if (changes.length) await pool.query('UPDATE client_limits SET notice = $2, updated_at = now() WHERE id = $1', [l.id, JSON.stringify({ at: now.toISOString(), what: changes.join('; ') })]);
    if (c.src === 'planned' || changes.length || fresh.length) {
      const what = [fresh.length ? `нова справа в суді: ${fresh.map(f => f.no).join(', ')}` : '', ...changes].filter(Boolean);
      await addLimitEvent(pool, l.id, 'planned', c.by ? { id: c.by, name: c.byName || '' } : null,
        (c.src === 'planned' ? 'Планова, раз на 3 місяці. ' : '') + (what.length ? 'Зміни: ' + what.join('; ') + '.' : 'Без змін.'));
    }
  }
  return { flagged, changes };
}
