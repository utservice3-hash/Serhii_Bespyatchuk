/**
 * 🎥 ЗАПИСИ СПІВБЕСІД tl;dv → РЯДОК ГРАФІКА (23.09.2026, прохід 7 плану найму; ключ дав Роман).
 *
 * Джоба раз на 15 хв бере `GET /v1alpha1/meetings?from=…&to=…` (заголовок `x-api-key`, база
 * `https://pasta.tldv.io`) і зіставляє зустрічі з рядками графіка.
 *
 * 🔴 ПЕВНИЙ ЗБІГ — ЛИШЕ ЗА ПОШТОЮ УЧАСНИКА. Час збігається в десятків людей: два рекрутери в один слот,
 * перенесена співбесіда, особиста зустріч організатора. Тому збіг за часом — це ПІДКАЗКА, яку підтверджує
 * людина, а не привʼязка. Правило 2 кореня: «рівно один» рахується серед УСІХ кандидатів, тож два рядки в
 * тому самому вікні — це «не впевнено», а не «беремо перший».
 *
 * 🔴 ВЕБХУКІВ НЕ БЕРЕМО: у документації tl;dv немає ні підпису, ні секрету для вхідних запитів (перевірено
 * 23.09.2026), тобто ендпоінт приймав би «зустріч готова» від кого завгодно.
 *
 * Транскрипти не зберігаємо — цей прохід лише про посилання на запис. Тримають #700–#703.
 */
export const TLDV_BASE = "https://pasta.tldv.io";
/** Вікно «той самий час» навколо початку співбесіди. Ширше — почнуться збіги із сусідніми слотами. */
export const NEAR_MIN = 30;

export interface TldvMeeting {
  id: string; name: string | null; happenedAt: string | null; duration: number | null;
  url: string | null; organizer: string | null; invitees: string[];
}
export interface SlotRow {
  id: number; interview_date: string; interview_time: string | null;
  full_name: string | null; email: string | null; tldv_meeting_id: string | null;
}
export type MatchHow = "email" | "time" | "none" | "many";
export interface MeetingMatch { meeting: TldvMeeting; interviewId: number | null; how: MatchHow; nearIds: number[] }

const mail = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
/** Київський час зустрічі як «РРРР-ММ-ДД» і хвилини від півночі — рядок графіка живе в київському дні. */
export function kyivParts(iso: string | null): { day: string; min: number } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const day = d.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const [hh, mm] = d.toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", hour12: false }).split(":");
  return { day, min: Number(hh) * 60 + Number(mm) };
}

/**
 * Чия це зустріч. Порядок значущий: пошта → час → нічого. Уже привʼязані рядки в кандидати не беруться —
 * інакше один запис перезаписав би інший.
 */
export function matchMeetings(meetings: TldvMeeting[], rows: SlotRow[]): MeetingMatch[] {
  return meetings.map((m) => {
    const emails = new Set(m.invitees.map(mail).filter(Boolean));
    const byMail = rows.filter((r) => r.email && emails.has(mail(r.email)) && !r.tldv_meeting_id);
    if (byMail.length === 1) return { meeting: m, interviewId: byMail[0].id, how: "email" as const, nearIds: [byMail[0].id] };
    const p = kyivParts(m.happenedAt);
    const near = p
      ? rows.filter((r) => r.interview_date === p.day && r.interview_time
          && Math.abs(Number(r.interview_time.slice(0, 2)) * 60 + Number(r.interview_time.slice(3, 5)) - p.min) <= NEAR_MIN
          && !r.tldv_meeting_id)
      : [];
    if (byMail.length > 1) return { meeting: m, interviewId: null, how: "many" as const, nearIds: byMail.map((r) => r.id) };
    if (near.length) return { meeting: m, interviewId: null, how: near.length === 1 ? "time" as const : "many" as const, nearIds: near.map((r) => r.id) };
    return { meeting: m, interviewId: null, how: "none" as const, nearIds: [] };
  });
}

/** Відповідь tl;dv → наші поля. Чужий формат розбираємо в ОДНОМУ місці, щоб зміна поля не розповзлась. */
export function parseMeetings(body: unknown): TldvMeeting[] {
  const list = (body as { results?: unknown[]; data?: unknown[] })?.results ?? (body as { data?: unknown[] })?.data ?? [];
  if (!Array.isArray(list)) return [];
  return list.map((x) => {
    const m = x as Record<string, unknown>;
    const inv = Array.isArray(m.invitees) ? m.invitees : [];
    const org = m.organizer as { email?: string; name?: string } | string | null;
    return {
      id: String(m.id ?? ""),
      name: typeof m.name === "string" ? m.name : null,
      happenedAt: typeof m.happenedAt === "string" ? m.happenedAt : null,
      duration: typeof m.duration === "number" ? Math.round(m.duration / 60) : null,
      url: typeof m.url === "string" ? m.url : m.id ? `https://app.tldv.io/meetings/${String(m.id)}` : null,
      organizer: typeof org === "string" ? org : (org?.email ?? org?.name ?? null),
      invitees: inv.map((i) => (typeof i === "string" ? i : String((i as { email?: string })?.email ?? ""))).filter(Boolean),
    };
  }).filter((m) => m.id);
}
