import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { jobSkip, type JobSkip } from "./jobRuns.js";
import { PROZORRO_NICHES } from "../core/prozorroNiches.js";
import { makeProzorroClient } from "../core/prozorroClient.js";
import { runProzorroCollect, type LeadRow, type PzCollectResult, type PzStore, type TenderRow } from "../core/prozorroCollect.js";
import { quietTooLong, reportText } from "../core/prozorroRules.js";

/**
 * 🏛 PROZORRO-ЛІДИ — ДЖОБА (задача #5299). Щодня о 06:05 за Києвом (`index.ts`), під наглядом (`monitoredJobs.ts`).
 *
 * Прохід 1: збір переможців і ПРОБНИЙ режим — рядки лягають у `prozorro_leads` з `mode = 'dry'`, у Kommo не пишеться
 * нічого (запису в CRM тут немає взагалі). Логіка — `core/prozorroCollect.ts`, правила — `core/prozorroRules.ts`.
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

export async function prozorroLeads(): Promise<PzCollectResult | JobSkip> {
  if (config.prozorro.mode.trim() === "off") return jobSkip("Prozorro-ліди вимкнено (PROZORRO_LEADS=off)");
  const client = makeProzorroClient({ fetch, sleep, nowMs: () => Date.now() });
  const now = new Date();
  const res = await runProzorroCollect({
    search: (text, page) => client.search(text, page), tender: (id) => client.tender(id),
    store: prozorroStore, niches: PROZORRO_NICHES, now, minAmount: config.prozorro.minAmount,
  });
  const last = await pool.query<{ at: Date | null }>(`SELECT max(created_at) AS at FROM prozorro_leads`);
  const quiet = !res.tally.baseline && quietTooLong(last.rows[0]?.at ?? null, res.launch, now);
  const text = reportText(res.tally, { mode: "dry", minAmount: config.prozorro.minAmount, quiet })
    + (res.verdict.ok ? "" : `\n🔴 ${res.verdict.error}`);
  console.log(`prozorroLeads: ${JSON.stringify({ ...res.tally, byNiche: undefined })}\n${text}`);
  if (!res.verdict.ok) throw new Error(res.verdict.error);
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  prozorroLeads()
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
