/**
 * 🚚 Правила вигляду вкладки «Перевізники за розмовою» — чисті функції, їх ганяє гейт без браузера.
 * Кошики й поріг — з бекенду (`carrierCallRules.ts`, METRICS_GLOSSARY §17); тут лише підписи й фільтри.
 */

export type CarrierBucketT = "carrier" | "client" | "other" | "unclear" | "low";
type Tone = "warn" | "ok" | "info" | "muted" | "bad";

export const TONE: Readonly<Record<Tone, { bg: string; fg: string }>> = {
  warn: { bg: "var(--warn-bg, #fef3c7)", fg: "var(--warn, #b45309)" },
  ok: { bg: "var(--ok-bg, #dcfce7)", fg: "var(--ok, #166534)" },
  info: { bg: "var(--info-bg, #eff6ff)", fg: "var(--info, #1d4ed8)" },
  muted: { bg: "var(--surface-2, #f0f1f3)", fg: "var(--text-muted, #6b7280)" },
  bad: { bg: "var(--danger-bg, #fee2e2)", fg: "var(--danger, #b91c1c)" },
};

export const BUCKET_UI: Readonly<Record<CarrierBucketT, { label: string; tone: Tone; hint: string }>> = {
  carrier: { label: "перевізник", tone: "warn", hint: "Має транспорт і шукає вантаж, пропонує перевезення чи питає оплату за рейс. Впевненість ≥ 0,85, цитата — зі слів співрозмовника." },
  client: { label: "клієнт", tone: "ok", hint: "Йому треба щось перевезти. Впевненість ≥ 0,85, цитата — зі слів співрозмовника." },
  other: { label: "інше", tone: "info", hint: "Розмова не про перевезення: реклама, опитування, вакансії, помилка номера." },
  unclear: { label: "не розібрати", tone: "muted", hint: "Розмова обірвалась або по суті її немає. Якщо була друга розмова номера — слухали і її." },
  low: { label: "невпевнено", tone: "muted", hint: "Модель не впевнена (менше 0,85) або цитата не знайдена в словах співрозмовника — вердикт не показуємо як факт." },
};

/**
 * 🧭 Вкладки (ТЗ Романа 30.09.2026): «Клієнти / Перевізники / Інше / На перевірці». Категорію дає бекенд
 * (`dealCategory`); «На перевірці» збирає всіх, кого ще не розсортовано: невпевнені й без розмови, «Помилка»,
 * і ті, кого AI ще слухає. Так вкладки разом = усі угоди періоду, і звіт з ними сходиться.
 */
export type CarrierCategoryT = "client" | "carrier" | "other" | "review" | "error" | "waiting";
export type CarrierTab = "client" | "carrier" | "other" | "review";
export const CARRIER_TABS: readonly { key: CarrierTab; label: string }[] = [
  { key: "client", label: "Клієнти" },
  { key: "carrier", label: "Перевізники" },
  { key: "other", label: "Інше" },
  { key: "review", label: "На перевірці" },
];
export function tabOf(c: CarrierCategoryT): CarrierTab {
  return c === "client" || c === "carrier" || c === "other" ? c : "review";
}
export const CATEGORY_UI: Readonly<Record<CarrierCategoryT, { label: string; tone: Tone }>> = {
  client: { label: "клієнт", tone: "ok" },
  carrier: { label: "перевізник", tone: "warn" },
  other: { label: "інше", tone: "info" },
  review: { label: "на перевірці", tone: "muted" },
  error: { label: "помилка", tone: "bad" },
  waiting: { label: "AI слухає", tone: "muted" },
};

/** Підтипи «Інше» — ті самі ключі й підписи, що `OTHER_TYPE_UA` бекенду (звіряє гейт). */
export type CarrierOtherTypeT = "spam" | "supplier" | "job_seeker" | "personal" | "wrong_number" | "other";
export const OTHER_TYPE_UI: Readonly<Record<CarrierOtherTypeT, string>> = {
  spam: "спам / реклама", supplier: "постачальник", job_seeker: "шукає роботу", personal: "особисте",
  wrong_number: "помилка номера", other: "інше",
};

/** Хто вирішив — для журналу й рядка. Роль невідома (рішення до 30.09.2026) — «керівник»: тоді вирішувало лише воно. */
export function deciderLabel(role: string | null): string {
  if (role === "manager") return "менеджер";
  if (role === "team_lead") return "тімлід";
  return "керівник";
}

/** Етап «Дзвінки на мобільні» (Кваліфікація) — як `CARRIER_STAGE.statusId` бекенду. */
export const CARRIER_STAGE_STATUS = 70419108;

/** Стан угоди в CRM зараз — словами (невідоме має читатись як невідоме). */
export function dealStatusLabel(statusId: number | null, rejectReason: string | null): string {
  if (statusId == null) return "у CRM: ще не підтягнули";
  if (statusId === CARRIER_STAGE_STATUS) return "у CRM: на етапі";
  if (statusId === 143) return rejectReason ? `у CRM: закрито (${rejectReason})` : "у CRM: закрито без причини";
  if (statusId === 142) return "у CRM: успішна";
  return "у CRM: пішла далі";
}

export const confLabel = (c: number | null): string => (c == null ? "—" : c.toFixed(2).replace(".", ","));

/** Хто говорить на каналі: без відомого каналу менеджера — чесно «Канал N». */
export function carrierSpeaker(channel: number, managerChannel: number | null): string {
  if (managerChannel == null) return `Канал ${String(channel)}`;
  return channel === managerChannel ? "Менеджер" : "Співрозмовник";
}

/** «1 угода · 2 угоди · 5 угод» — українська множина. */
export function dealsWord(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "угода";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "угоди";
  return "угод";
}

/** Стан закриття угоди в CRM — словами. `null` — автоматика угоду не чіпала. */
export function closeLabel(c: { state: string; at: string; reason?: string } | null, fmt: (iso: string) => string): string | null {
  if (!c) return null;
  const why = c.reason === "other" ? "«Нецільове звернення»" : "«Перевізник»";
  if (c.state === "closed") return `закрито в CRM ${fmt(c.at)} · ${why}`;
  if (c.state === "reverted") return `повернуто на етап ${fmt(c.at)}`;
  if (c.state === "failed") return "не вдалось закрити в CRM — спробуємо ще";
  return `закриємо як ${why} (поки лише журнал)`;
}

/** Режим закриття — для рядка стану. */
export function closeModeLabel(mode: string): string {
  if (mode === "live") return "закриття в CRM увімкнено";
  if (mode === "off") return "закриття в CRM вимкнено";
  return "закриття в CRM — лише журнал, у CRM нічого не пишемо";
}

/** Режим закриття AI-«Інше» (окремий перемикач; вимкнений основний режим вимикає і його). */
export function otherModeLabel(mode: string, otherMode: string): string {
  if (mode === "off" || otherMode === "off") return "не закриваємо";
  if (mode === "live" && otherMode === "live") return "закриваємо в CRM";
  return "поки лише журнал (до тесту точності)";
}

/** 🙋 Рішення людини по невпевнених — підписи й кольори кнопок. */
export type HumanDecisionT = "carrier" | "client" | "other";
export const DECISION_UI: Readonly<Record<HumanDecisionT, { label: string; icon: string; hint: string; bg: string; fg: string }>> = {
  carrier: { label: "Перевізник", icon: "🚚", hint: "Закриємо в CRM як «Не цільові · Перевізник»", bg: TONE.warn.bg, fg: TONE.warn.fg },
  client: { label: "Клієнт", icon: "👤", hint: "Лишиться на етапі з позначкою «клієнт», AI більше не чіпає", bg: TONE.ok.bg, fg: TONE.ok.fg },
  other: { label: "Інше", icon: "💬", hint: "Закриємо в CRM як «Не цільові · Нецільове звернення», підтип — у примітці", bg: TONE.info.bg, fg: TONE.info.fg },
};
/** Що сказав AI — підпис і колір (сирі ролі моделі, не кошики). */
export const ROLE_UI: Readonly<Record<string, { label: string; bg: string; fg: string }>> = {
  carrier: { label: "перевізник", bg: TONE.warn.bg, fg: TONE.warn.fg },
  client: { label: "клієнт", bg: TONE.ok.bg, fg: TONE.ok.fg },
  other: { label: "інше", bg: TONE.info.bg, fg: TONE.info.fg },
  unclear: { label: "не розібрати", bg: TONE.muted.bg, fg: TONE.muted.fg },
};
/** Коротко, для черги: «Він» — співрозмовник, «Менеджер»; канал невідомий — чесно «Канал N». */
export function speakerShort(channel: number, managerChannel: number | null): string {
  if (managerChannel == null) return `Канал ${String(channel)}`;
  return channel === managerChannel ? "Менеджер" : "Він";
}
