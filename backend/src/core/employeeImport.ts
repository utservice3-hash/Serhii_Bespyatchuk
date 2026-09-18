/**
 * 🗂 ІМПОРТ «UTS Співробітники УКР» — ЧИСТІ ПРАВИЛА (18.09.2026, задача №3898). Без БД і без `config`.
 *
 * Таблицю ніхто, крім сервера, не читає: людина кладе CSV (Файл → Завантажити → CSV), сервер
 * розбирає заголовки й пропонує, яка колонка чим є. Людина підтверджує або міняє — і лише тоді
 * рядки лягають у реєстр, а паролі й картки — у сейф шифром.
 *
 * 🔴 ГОЛОВНА МЕЖА: колонка, чий заголовок схожий на пароль, PIN, CVV, картку чи IBAN, НЕ МОЖЕ
 * піти в поле реєстру чи в `extra` — лише в сейф або «пропустити». Це вирішує СЕРВЕР
 * (`validateMapping`), а не екран: інакше одне неуважне клацання клало б пароль текстом у базу.
 * Тримає #561.
 */

/** Цілі, куди може піти колонка. `secret:` — у сейф; решта — поля реєстру. */
export const PLAIN_TARGETS = [
  ["full_name", "ПІБ"], ["last_name", "Прізвище"], ["first_name", "Імʼя"], ["middle_name", "По батькові"],
  ["position", "Посада"], ["team_label", "Команда / відділ"], ["phone", "Телефон"], ["email", "Пошта"],
  ["telegram", "Telegram"], ["birth_date", "Дата народження"], ["hired_at", "Дата прийому"],
  ["dismissed_at", "Дата звільнення"], ["dismiss_reason", "Причина звільнення"], ["note", "Примітка"],
  ["extra", "Зберегти як є"], ["skip", "Пропустити"],
] as const;
export type PlainTarget = (typeof PLAIN_TARGETS)[number][0];

/** Сервіси сейфу — ті самі ключі, що `secretBox.SECRET_SERVICES`. */
const SERVICE_WORDS: [string, RegExp][] = [
  ["kommo", /kommo|комо|amo ?crm|амо/i], ["ringostat", /ringostat|рінгостат|рингостат/i],
  ["trans_eu", /trans\.?\s?eu|транс\.?\s?еу/i], ["lardi", /lardi|ларді|larde/i], ["della", /della|делла/i],
  ["yaware", /yaware|яваре/i], ["dashboard", /дашборд|dashboard/i],
  ["mail", /пошт|mail|gmail|e-?mail|ukr\.net/i],
];

export const SECRETISH = /парол|pass|pwd|пін\b|pin\b|cvv|cvc|карт|card|iban|рахун|secret|токен|token/i;
const PASSWORDISH = /парол|pass|pwd|пін\b|pin\b|secret|токен|token/i;
const CARDISH = /карт|card|iban|рахун/i;
const LOGINISH = /логін|login|user|юзер|акаунт|account/i;

export interface ColumnGuess { index: number; header: string; target: string; secretish: boolean; filled: number }

/** Секрет-ціль: `secret:password:<service>`, `secret:login:<service>`, `secret:card`. */
export const isSecretTarget = (t: string) => t.startsWith("secret:");
const serviceOf = (h: string): string => SERVICE_WORDS.find(([, re]) => re.test(h))?.[0] ?? "other";

/** Здогад за назвою. Порядок має значення: «Пароль пошта» — пароль, не пошта. */
export function guessTarget(header: string): string {
  const h = header.trim();
  if (!h) return "skip";
  if (CARDISH.test(h)) return "secret:card";
  if (PASSWORDISH.test(h)) return `secret:password:${serviceOf(h)}`;
  if (LOGINISH.test(h) && serviceOf(h) !== "other") return `secret:login:${serviceOf(h)}`;
  const l = h.toLowerCase();
  if (/^піб$|^фіо$|^п\.?і\.?б|прізвище.*ім|^співробітник$|^пі$/.test(l)) return "full_name";
  if (/^прізвище$/.test(l)) return "last_name";
  if (/^ім[ʼ'’`]?я$|^имя$/.test(l)) return "first_name";
  if (/по.?батькові/.test(l)) return "middle_name";
  if (/посад/.test(l)) return "position";
  if (/команд|відділ|отдел|тімлід|тимлид/.test(l)) return "team_label";
  if (/телеф|моб|phone|тел\.?$/.test(l)) return "phone";
  if (/telegram|телеграм|тг\b/.test(l)) return "telegram";
  if (/народж|д\.?н\.?$|birth/.test(l)) return "birth_date";
  if (/звільн|уволь/.test(l) && /дат/.test(l)) return "dismissed_at";
  if (/причин/.test(l)) return "dismiss_reason";
  if (/прийом|прийнят|працевлашт|початок|вихід на роботу|дата старту|hired/.test(l)) return "hired_at";
  if (/пошт|e-?mail|mail/.test(l) && !/парол/.test(l)) return "email";
  if (/приміт|коментар|note/.test(l)) return "note";
  return "skip";
}

export class ImportError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/**
 * Перевірка вибору людини. Секретоподібний заголовок — лише в сейф або «пропустити».
 * Одна ціль реєстру — одна колонка (крім `extra`/`skip`). Кидає `ImportError(400)`.
 */
export function validateMapping(headers: string[], mapping: string[]): void {
  if (mapping.length !== headers.length) throw new ImportError(400, "Зіставлення не збігається з кількістю колонок");
  const plain = new Set<string>(PLAIN_TARGETS.map(([k]) => k));
  const seen = new Map<string, number>();
  mapping.forEach((t, i) => {
    const h = headers[i];
    if (isSecretTarget(t)) {
      if (!/^secret:(card|password:[a-z_]+|login:[a-z_]+)$/.test(t)) throw new ImportError(400, `Невідома ціль «${t}»`);
    } else {
      if (!plain.has(t)) throw new ImportError(400, `Невідома ціль «${t}»`);
      if (t !== "skip" && SECRETISH.test(h)) throw new ImportError(400, `Колонка «${h}» схожа на пароль або картку — її можна лише в сейф або пропустити`);
      if (t !== "skip" && t !== "extra") {
        if (seen.has(t)) throw new ImportError(400, `«${h}» і «${headers[seen.get(t)!]}» обидві вказані як одне поле`);
        seen.set(t, i);
      }
    }
  });
  if (!seen.has("full_name") && !seen.has("last_name")) throw new ImportError(400, "Вкажіть колонку з ПІБ або з прізвищем");
}

/** CSV за RFC 4180: лапки, коми й переноси всередині лапок, BOM, CRLF. Роздільник — кома або `;`. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && cell === "") q = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Нормалізоване ПІБ — ключ реєстру: регістр, апострофи, пробіли, «ё/ї» як є. */
export const nameKey = (s: string): string =>
  s.toLowerCase().replace(/[ʼ'’`]/g, "'").replace(/[^\p{L}' -]/gu, " ").replace(/\s+/g, " ").trim();

/** Прізвище + імʼя (перші два слова) — для зіставлення з акаунтом. */
export const shortKey = (s: string): string => nameKey(s).split(" ").slice(0, 2).sort().join(" ");

/** Дата з «31.12.2024», «31.12.24», «2024-12-31», «31/12/2024». Решта — `null`. */
export function parseDate(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  let y: number, mo: number, d: number;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/.exec(s))) {
    d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += y > 40 ? 1900 : 2000;
  } else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 1930 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface PlainRow {
  line: number; full_name: string; key: string; short: string;
  fields: Record<string, string | null>; extra: Record<string, string>;
  secrets: { kind: "password" | "card"; service: string; label: string | null; login: string | null; value: string }[];
  problems: string[];
}

/**
 * Рядки таблиці → людина реєстру + її секрети. Значення секретів лишаються ТУТ, у памʼяті запиту:
 * у прев'ю їх не віддає ніхто (`previewRow` бере лише прапорці).
 */
export function buildRows(table: string[][], mapping: string[]): PlainRow[] {
  const [headers, ...body] = table;
  validateMapping(headers, mapping);
  return body.map((cells, n) => {
    const get = (i: number) => (cells[i] ?? "").trim();
    const f: Record<string, string | null> = {}, extra: Record<string, string> = {}, problems: string[] = [];
    const logins = new Map<string, string>();
    const secrets: PlainRow["secrets"] = [];
    mapping.forEach((t, i) => {
      const v = get(i);
      if (!v || t === "skip") return;
      if (t === "extra") { extra[headers[i]] = v; return; }
      if (t.startsWith("secret:login:")) { logins.set(t.slice(13), v); return; }
      if (t === "secret:card") { secrets.push({ kind: "card", service: "card", label: null, login: null, value: v }); return; }
      if (t.startsWith("secret:password:")) {
        const service = t.slice(16);
        secrets.push({ kind: "password", service, label: service === "other" ? headers[i].slice(0, 80) : null, login: null, value: v });
        return;
      }
      f[t] = v;
    });
    for (const s of secrets) if (s.kind === "password") s.login = logins.get(s.service) ?? null;
    const name = f.full_name ?? [f.last_name, f.first_name, f.middle_name].filter(Boolean).join(" ");
    for (const d of ["birth_date", "hired_at", "dismissed_at"]) {
      if (f[d] != null) { const p = parseDate(f[d]!); if (!p) problems.push(`дата «${f[d]}» не розпізнана`); f[d] = p; }
    }
    if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) { problems.push("пошта не схожа на адресу"); f.email = null; }
    delete f.full_name; delete f.last_name; delete f.first_name; delete f.middle_name;
    return { line: n + 2, full_name: name.replace(/\s+/g, " ").trim(), key: nameKey(name), short: shortKey(name), fields: f, extra, secrets, problems };
  }).filter((r) => r.key !== "");
}
