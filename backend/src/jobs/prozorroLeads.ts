import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { jobSkip, type JobSkip } from "./jobRuns.js";
import { PROZORRO_NICHES } from "../core/prozorroNiches.js";
import { makeProzorroClient } from "../core/prozorroClient.js";
import { runProzorroCollect, type LeadRow, type PzCollectResult, type PzStore, type TenderRow } from "../core/prozorroCollect.js";
import { quietTooLong, reportText } from "../core/prozorroRules.js";
import { kommoGet, kommoWrite } from "../kommo/client.js";
import { COMPANY_EDRPOU_FIELD, MAX_PUSH_ATTEMPTS, pushLeads, pzMode, responsibleProblem, type KommoPushDeps, type PendingLead, type PushStore,
  type PushTally, type Responsible } from "../core/prozorroPush.js";

/**
 * 🏛 PROZORRO-ЛІДИ — ДЖОБА (задача #5299). Щодня о 06:05 за Києвом (`index.ts`), під наглядом (`monitoredJobs.ts`).
 *
 * Режим — змінна `PROZORRO_LEADS` (`pzMode`): пробний (за замовчуванням) — рядки лягають у `prozorro_leads` з `mode = 'dry'`,
 * у Kommo НЕ пишеться нічого; «live» — рядки з `mode = 'live'` і ПІСЛЯ збору запис у Kommo (`core/prozorroPush.ts`) на
 * лідогена з «Налаштувань», не більше `PROZORRO_PUSH_LIMIT` за прохід. Рядки пробного режиму в Kommo НЕ йдуть ніколи.
 * Логіка збору — `core/prozorroCollect.ts`, правила — `core/prozorroRules.ts`.
 * Наприкінці — звіт (форма з ТЗ) у ЛОГ сервера; у Telegram НЕ шлемо (рішення Романа 23.10.2026: «без звіту в телеграм»).
 * Якщо вирок «аварія», джоба ПІСЛЯ запису звіту в лог падає — це видно в банері (runJob → епізоди), Telegram для цього не потрібен.
 *
 * Ручний запуск на сервері: `node dist/jobs/prozorroLeads.js`.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const prozorroStore: PzStore = {
  async knownTenders(ids) {
    if (!ids.length) return new Set();
    const r = await pool.query<{ ua_id: string }>(`SELECT ua_id FROM prozorro_tenders WHERE ua_id = ANY($1::text[])`, [ids]);
    return new Set(r.rows.map((x) => x.ua_id));
  },
  async firstSeenAt() {
    const r = await pool.query<{ at: Date | null }>(`SELECT min(first_seen_at) AS at FROM prozorro_tenders`);
    return r.rows[0]?.at ?? null;
  },
  async saveTenders(rows: TenderRow[]) {
    for (let i = 0; i < rows.length; i += 500) {
      const b = rows.slice(i, i + 500);
      await pool.query(
        `INSERT INTO prozorro_tenders (ua_id, hex_id, title, status, amount, currency, niches, keywords, award_date, baseline, raw)
         SELECT x.ua_id, x.hex_id, x.title, x.status, x.amount, x.currency, x.niches, x.keywords, x.award_date, x.baseline, x.raw
           FROM jsonb_to_recordset($1::jsonb) AS x(ua_id text, hex_id text, title text, status text, amount numeric, currency text,
                niches text[], keywords text[], award_date timestamptz, baseline boolean, raw jsonb)
         ON CONFLICT (ua_id) DO NOTHING`,
        [JSON.stringify(b.map((r) => ({ ua_id: r.uaId, hex_id: r.hexId, title: r.title, status: r.status, amount: r.amount,
          currency: r.currency, niches: r.niches, keywords: r.keywords, award_date: r.awardDate, baseline: r.baseline, raw: r.raw })))]);
    }
  },
  async knownCompanies(edrpous) {
    const r = await pool.query<{ edrpou: string }>(`SELECT DISTINCT edrpou FROM prozorro_leads WHERE edrpou = ANY($1::text[])`, [edrpous]);
    return new Set(r.rows.map((x) => x.edrpou));
  },
  async crmCompanies(edrpous) {
    const r = await pool.query<{ edrpou: string; id: string }>(
      `SELECT edrpou, min(company_id)::text AS id FROM kommo_companies WHERE edrpou = ANY($1::text[]) GROUP BY edrpou`, [edrpous]);
    return new Map(r.rows.map((x) => [x.edrpou, Number(x.id)]));
  },
  async saveLeads(rows: LeadRow[]) {
    const r = await pool.query<{ edrpou: string; ua_id: string }>(
      `INSERT INTO prozorro_leads (edrpou, ua_id, role, company_name, region, city, address, contact_name, phone, email, amount,
                                   currency, award_date, niches, keywords, card_text, mode, kommo_company_existing)
       SELECT x.edrpou, x.ua_id, x.role, x.company_name, x.region, x.city, x.address, x.contact_name, x.phone, x.email, x.amount,
              x.currency, x.award_date, x.niches, x.keywords, x.card_text, x.mode, x.kommo_company_existing
         FROM jsonb_to_recordset($1::jsonb) AS x(edrpou text, ua_id text, role text, company_name text, region text, city text,
              address text, contact_name text, phone text, email text, amount numeric, currency text, award_date timestamptz,
              niches text[], keywords text[], card_text text, mode text, kommo_company_existing bigint)
       ON CONFLICT (edrpou, ua_id, role) DO NOTHING
       RETURNING edrpou, ua_id`,
      [JSON.stringify(rows.map((l) => ({ edrpou: l.edrpou, ua_id: l.uaId, role: l.role, company_name: l.companyName, region: l.region,
        city: l.city, address: l.address, contact_name: l.contactName, phone: l.phone, email: l.email, amount: l.amount,
        currency: l.currency, award_date: l.awardDate, niches: l.niches, keywords: l.keywords, card_text: l.card, mode: l.mode,
        kommo_company_existing: l.kommoCompanyExisting })))]);
    const got = new Set(r.rows.map((x) => `${x.edrpou}|${x.ua_id}`));
    return rows.filter((l) => got.has(`${l.edrpou}|${l.uaId}`));
  },
};

/** Хто веде тендерні ліди — з «Налаштувань» (`prozorro_settings`); null — не вибрано. */
export async function readResponsible(): Promise<Responsible | null> {
  const r = await pool.query<{ id: number; name: string; kommo_user_id: string | null; is_active: boolean }>(
    `SELECT m.id, m.name, m.kommo_user_id::text, m.is_active FROM prozorro_settings s JOIN managers m ON m.id = s.responsible_manager_id
      WHERE s.id = 1`);
  const x = r.rows[0];
  return x ? { managerId: x.id, name: x.name, kommoUserId: x.kommo_user_id ? Number(x.kommo_user_id) : null, active: x.is_active } : null;
}

/** Черга на запис: лише рядки бойового режиму, ще без угоди, з невичерпаними спробами; найстаріші першими. */
export async function readPending(maxAttempts: number): Promise<PendingLead[]> {
  const r = await pool.query<{ id: string; edrpou: string; ua_id: string; company_name: string; address: string | null; contact_name: string | null;
    phone: string | null; email: string | null; title: string | null; card_text: string; kommo_company_existing: string | null }>(
    `SELECT l.id::text, l.edrpou, l.ua_id, l.company_name, l.address, l.contact_name, l.phone, l.email, t.title, l.card_text,
            l.kommo_company_existing::text
       FROM prozorro_leads l JOIN prozorro_tenders t ON t.ua_id = l.ua_id
      WHERE l.mode = 'live' AND l.kommo_lead_id IS NULL AND l.push_attempts < $1
      ORDER BY l.created_at, l.id`, [maxAttempts]);
  return r.rows.map((x) => ({ id: Number(x.id), edrpou: x.edrpou, uaId: x.ua_id, companyName: x.company_name, address: x.address,
    contactName: x.contact_name, phone: x.phone, email: x.email, title: x.title, card: x.card_text,
    kommoCompanyExisting: x.kommo_company_existing ? Number(x.kommo_company_existing) : null }));
}

const pushStore: PushStore = {
  async saved(id, r) {
    await pool.query(`UPDATE prozorro_leads SET responsible_user_id = $2, kommo_company_id = $3, kommo_contact_id = $4, kommo_lead_id = $5,
                             pushed_at = now(), push_error = NULL WHERE id = $1`, [id, r.responsible, r.companyId, r.contactId, r.leadId]);
  },
  async failed(id, error) {
    await pool.query(`UPDATE prozorro_leads SET push_error = $2, push_attempts = push_attempts + 1 WHERE id = $1`, [id, error]);
  },
};

const firstId = (r: unknown, key: string): number => {
  const id = (r as { _embedded?: Record<string, { id?: number }[]> })._embedded?.[key]?.[0]?.id;
  if (typeof id !== "number") throw new Error(`Kommo не повернув id (${key})`);
  return id;
};
export const kommoPush: KommoPushDeps = {
  async findCompany(edrpou) {
    const r = await kommoGet<{ _embedded?: { companies?: { id: number; custom_fields_values?: { field_id: number; values?: { value?: unknown }[] }[] }[] } }>(
      `/api/v4/companies?query=${encodeURIComponent(edrpou)}&limit=50`);
    const hit = (r._embedded?.companies ?? []).filter((c) => (c.custom_fields_values ?? []).some((f) => f.field_id === COMPANY_EDRPOU_FIELD
      && (f.values ?? []).some((v) => String(v.value ?? "").replace(/\D/g, "") === edrpou)));
    return hit.length ? Math.min(...hit.map((c) => c.id)) : null;
  },
  createCompany: async (body) => firstId(await kommoWrite("/api/v4/companies", [body]), "companies"),
  createContact: async (body) => firstId(await kommoWrite("/api/v4/contacts", [body]), "contacts"),
  createLead: async (body) => firstId(await kommoWrite("/api/v4/leads", [body]), "leads"),
  async addNote(leadId, text) {
    await kommoWrite(`/api/v4/leads/${String(leadId)}/notes`, [{ note_type: "common", params: { text } }]);
  },
};

export async function prozorroLeads(): Promise<(PzCollectResult & { push: PushTally | null; pushWaiting: string | null }) | JobSkip> {
  const mode = pzMode(config.prozorro.mode);
  if (mode === "off") return jobSkip("Prozorro-ліди вимкнено (PROZORRO_LEADS=off)");
  const client = makeProzorroClient({ fetch, sleep, nowMs: () => Date.now() });
  const now = new Date();
  const res = await runProzorroCollect({
    search: (text, page) => client.search(text, page), tender: (id) => client.tender(id),
    store: prozorroStore, niches: PROZORRO_NICHES, now, minAmount: config.prozorro.minAmount, mode,
  });
  // ✍️ Запис у Kommo — ЛИШЕ в бойовому режимі. Лідоген не вибраний / неактивний — не пишемо нічого, рядки чекають.
  let push: PushTally | null = null;
  let pushWaiting: string | null = null;
  if (mode === "live") {
    const pending = await readPending(MAX_PUSH_ATTEMPTS);
    const who = await readResponsible();
    const problem = responsibleProblem(who);
    if (problem) pushWaiting = `${problem}; чекають запису: ${String(pending.length)}`;
    else push = await pushLeads(pending, who!.kommoUserId!, kommoPush, pushStore, config.prozorro.pushLimit);
  }
  const last = await pool.query<{ at: Date | null }>(`SELECT max(created_at) AS at FROM prozorro_leads`);
  const quiet = !res.tally.baseline && quietTooLong(last.rows[0]?.at ?? null, res.launch, now);
  const text = reportText(res.tally, { mode: mode === "live" ? "live" : "dry", minAmount: config.prozorro.minAmount, quiet })
    + (push ? `\nKommo: записано ${String(push.pushed)} з ${String(push.pending)} у черзі, невдало ${String(push.failed)}, наявних компаній ${String(push.companiesReused)}` : "")
    + (pushWaiting ? `\n⚠️ Kommo: ${pushWaiting}` : "")
    + (res.verdict.ok ? "" : `\n🔴 ${res.verdict.error}`);
  console.log(`prozorroLeads: ${JSON.stringify({ ...res.tally, byNiche: undefined })}\n${text}`);
  if (!res.verdict.ok) throw new Error(res.verdict.error);
  // Kommo відмовив у доступі — це аварія запису, не «успіх із нулем»: джоба падає, банер показує причину.
  if (push?.stoppedBy) throw new Error(`Prozorro → Kommo: запис зупинено — ${push.stoppedBy}`);
  return { ...res, push, pushWaiting };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  prozorroLeads()
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
