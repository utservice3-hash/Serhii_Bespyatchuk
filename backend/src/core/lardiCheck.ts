import { pool } from "../db/pool.js";
import { hasLardiToken, lardiGet, LANG } from "../lardi/client.js";
import { PHONE9 } from "./carrierLardi.js";
import { LARDI_CHECK_DAYS, archiveSummary, lardiVerdict, parseLardiProfile, parseLardiUsers, type ArchiveOffer, type LardiUser, type RegistryMain } from "./lardiCheckRules.js";
import { REGISTRY_MAX_CODES, registryByCode, type RegistryLookup } from "./lardiRegistry.js";

/**
 * 🔎 Перевірка номера на Ларді (задача 8136): живий пошук користувача + заявки з власного архіву. Правила й межі —
 * `lardiCheckRules.ts`. У Ларді нічого не пишемо; у базу — лише кеш ЄДР (`lardi_registry_cache`, див. нижче).
 *
 * 🏛 З 24.11.2026 для кожного знайденого користувача — ще й вид діяльності з ЄДР (YouControl) за `firmCode` з його
 * профілю Ларді. Автоматично, без кнопки (рішення Романа 24.11). Транспортний основний КВЕД
 * дає вердикт «експедиція / перевізник — не передавати», коли заявок в архіві немає (8136; правило — `lardiVerdict`).
 */

/** Заявки з архіву за номером (останні 9 цифр) у вікні. Одна заявка, знайдена на кількох маршрутах, — один рядок. */
export async function archiveOffersByPhone(p9: string): Promise<ArchiveOffer[]> {
  const r = await pool.query<{
    side: string; offer_id: string; company: string | null; face: string | null; frm: string | null; tox: string | null;
    cargo: string | null; mass: string | null; total: string | null; currency: string | null; negotiable: boolean | null; seen: string;
  }>(
    `SELECT DISTINCT ON (o.side, o.offer_id) o.side, o.offer_id::text, o.company, o.face, o.frm, o.tox, o.cargo, o.mass, o.total,
            o.currency, o.negotiable, to_char(o.first_seen AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS seen
       FROM lardi_offers o
      WHERE o.first_seen >= now() - make_interval(days => $2)
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.phones) p WHERE ${PHONE9("p->>'n'")} = $1)
      ORDER BY o.side, o.offer_id, o.first_seen DESC`, [p9, LARDI_CHECK_DAYS]);
  const num = (v: string | null) => (v == null ? null : Number(v));
  return r.rows.map((x) => ({
    side: x.side === "lorry" ? "lorry" : "cargo", offerId: x.offer_id, company: x.company, face: x.face, from: x.frm, to: x.tox,
    cargo: x.cargo, mass: num(x.mass), total: num(x.total), currency: x.currency, negotiable: x.negotiable === true, seenAt: x.seen,
  }));
}

/** Живий пошук користувача Ларді за номером. `ok=false` — Ларді не відповів 200 (стан — у `status`), це НЕ «не знайдено». */
export async function lardiUsersByPhone(p9: string): Promise<{ ok: boolean; status: number; users: LardiUser[] }> {
  if (!hasLardiToken()) return { ok: false, status: 0, users: [] };
  try {
    const res = await lardiGet("/v2/users/search", { language: LANG, query: `380${p9}`, queryLimit: 5 });
    if (res.status !== 200) return { ok: false, status: res.status, users: [] };
    return { ok: true, status: 200, users: parseLardiUsers(await res.json()) };
  } catch {
    return { ok: false, status: 0, users: [] };
  }
}

/**
 * Код фірми з профілю Ларді (`GET /v2/users/user/{refId}`). Пошук за документацією теж повертає структуру «Пользователь»,
 * але в прикладі відповіді `firmCode` немає — тому профіль питаємо лише тим, кому пошук коду не дав. Збій — `null`:
 * без коду лишається рядок «код фірми Ларді не віддав», а не помилка всієї перевірки.
 */
export async function lardiFirmCode(refId: number): Promise<string | null> {
  try {
    const res = await lardiGet(`/v2/users/user/${refId}`, { language: LANG });
    if (res.status !== 200) return null;
    return parseLardiProfile(await res.json())?.firmCode ?? null;
  } catch {
    return null;
  }
}

/** Кожному користувачу — його код (з пошуку або профілю) і ЄДР за ним. Різних кодів — не більше `REGISTRY_MAX_CODES`. */
export async function withRegistry(users: LardiUser[]): Promise<Array<LardiUser & { registry: RegistryLookup | null }>> {
  const coded = await Promise.all(users.map(async (u) => (u.firmCode ? u : { ...u, firmCode: await lardiFirmCode(u.refId) })));
  const codes = [...new Set(coded.map((u) => u.firmCode).filter((c): c is string => !!c))].slice(0, REGISTRY_MAX_CODES);
  const found = new Map(await Promise.all(codes.map(async (c) => [c, await registryByCode(pool, c)] as const)));
  return coded.map((u) => ({ ...u, registry: (u.firmCode && found.get(u.firmCode)) || null }));
}

/** Основний вид діяльності для вердикту — лише з успішної картки ЄДР; інакше `null` («невідомо», а не «не транспорт»). */
export function registryMain(u: { name: string; registry: RegistryLookup | null }): RegistryMain {
  if (u.registry?.state !== "ok") return { company: u.name, activity: null };
  const acts = u.registry.info.activities;
  return { company: u.name, activity: acts.find((a) => a.main) ?? acts[0] ?? null };
}

export async function lardiCheck(p9: string) {
  const [live, offers] = await Promise.all([lardiUsersByPhone(p9), archiveOffersByPhone(p9)]);
  const archive = archiveSummary(offers);
  const users = await withRegistry(live.users);
  return {
    phone: `+380${p9}`,
    verdict: lardiVerdict({ users: live.users.length, cargo: archive.cargo, lorry: archive.lorry, liveOk: live.ok, registry: users.map(registryMain) }),
    lardi: { ok: live.ok, status: live.status, users },
    archive, days: LARDI_CHECK_DAYS,
  };
}
