/**
 * 🔎 ЄДР через YouScore (`constructor/youscore.ts`) — гейти #1160–#1163. Без мережі й без справжнього ключа:
 * `lookupRegistry` отримує фальшивий `fetch` і базу в памʼяті. Фікстури — ВИГАДАНІ компанії й люди (репозиторій
 * публічний), а форма — рівно та, що заміряна на проді 30.09.2026: юрособа з `name{fullName}` і `signers`, ФОП з
 * `name` рядком і без `code`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { toCounterparty, toGuillemets, personName, lookupRegistry, CACHE_DAYS, type Db } from "./youscore.js";

const LEGAL = {
  code: "12345678", status: "Не перебуває в процесі припинення", actualDate: "2026-09-30T18:55:56Z",
  contractorType: "Юридична особа (ЮО)",
  name: { fullName: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "КФ "ТЕСТОВІ ПЕРЕВЕЗЕННЯ"', shortName: 'ТОВ "КФ "ТП"' },
  address: "Україна, 01001, місто Київ, вул. Тестова, будинок 1",
  signers: [{ role: "підписант", name: "Другий Підписант Тестович" }, { role: "керівник", name: "Тестенко Остап Петрович" }],
  contacts: { phone: "+380 44 000 00 00", email: "office@test.example" },
  founders: [{ name: "ЗАСНОВНИК ТЕСТОВИЙ" }], terminationStatus: null, bankruptcyStatus: null,
};
const FOP = {
  name: "ТЕСТЕНКО МАРІЯ ІВАНІВНА", status: "Не перебуває в процесі припинення", actualDate: "2026-09-30T19:10:00Z",
  contractorType: "Фізична особа-підприємець (ФОП)", address: "Україна, 79000, місто Львів",
  contacts: { phone: "+380 67 000 00 00", email: null },
};
const DEAD = {
  ...LEGAL, code: "87654321", status: "Припинено",
  registrationOfTermination: { entryDate: "2025-01-10", entryNumber: "1", status: "припинено" },
  bankruptcyStatus: { event: "визнано банкрутом" },
};

/** #1160 — картка з ЄДР у полях форми: назва скорочена з ялинками, керівник — саме «керівник», ФОП — ПІБ. */
test("#1160 КАРТКА З ЄДР: юрособа, ФОП і припинена — поля форми рівно ті, засновники не потрапляють", () => {
  const a = toCounterparty("12345678", LEGAL, { code: "123456789012" });
  assert.deepEqual(a, {
    edrpou: "12345678", name: "ТОВ «КФ «ТЕСТОВІ ПЕРЕВЕЗЕННЯ»", ipn: "123456789012",
    addr: "Україна, 01001, місто Київ, вул. Тестова, будинок 1", dir: "Тестенко Остап Петрович",
    phone: "+380 44 000 00 00", email: "office@test.example", isFop: false,
    actualDate: "2026-09-30T18:55:56Z", status: "Не перебуває в процесі припинення", warn: null,
  }, "🔴 картка юрособи розійшлась із реєстром (керівник — не перший підписант, а роль «керівник»)");
  assert.ok(!JSON.stringify(a).includes("ЗАСНОВНИК"), "🔴 засновники потрапили в картку");

  const f = toCounterparty("1234567890", FOP, null);
  assert.equal(f.isFop, true); assert.equal(f.edrpou, "1234567890", "🔴 у ФОП коду в тілі немає — має лишитись запитаний");
  assert.equal(f.name, "ФОП Тестенко Марія Іванівна"); assert.equal(f.dir, "Тестенко Марія Іванівна");
  assert.equal(f.ipn, "", "🔴 не платник ПДВ — поле порожнє, а не вигадане");
  assert.equal(f.email, "");

  const d = toCounterparty("87654321", DEAD, null);
  assert.match(d.warn ?? "", /припинено/, "🔴 припинену компанію не позначено");
  assert.match(d.warn ?? "", /банкрут/, "🔴 банкрутство не позначено");
  assert.equal(toCounterparty("12345678", { ...LEGAL, status: "Не перебуває в процесі припинення" }, null).warn, null,
    "🔴 «НЕ перебуває в процесі припинення» прочитано як припинення");
});

test("#1160b ЛАПКИ Й ПІБ: вкладені лапки → ялинки; ПІБ великими → звичайний регістр, нормальний не чіпається", () => {
  assert.equal(toGuillemets('ТОВ "КФ "ЛАСОЩІ""'), "ТОВ «КФ «ЛАСОЩІ»»");
  assert.equal(toGuillemets('ПП "ВЕКТОР"'), "ПП «ВЕКТОР»");
  assert.equal(personName("ТЕСТЕНКО-ПЕТРЕНКО ОЛЕНА ІВАНІВНА"), "Тестенко-Петренко Олена Іванівна");
  assert.equal(personName("Тестенко Олена Іванівна"), "Тестенко Олена Іванівна");
  assert.equal(personName("  ОБ'ЄДНАНИЙ   ТЕСТ "), "Об'єднаний Тест");
});

/** База в памʼяті рівно на два запити модуля. */
function memDb(): Db & { rows: Map<string, { card: unknown; fetched_at: string }> } {
  const rows = new Map<string, { card: unknown; fetched_at: string }>();
  return {
    rows,
    async query(text: string, params: unknown[] = []) {
      if (/^\s*SELECT card, fetched_at FROM youscore_cache/.test(text)) {
        const r = rows.get(String(params[0])); return { rows: r ? [r] : [], rowCount: r ? 1 : 0 } as any;
      }
      if (/^\s*INSERT INTO youscore_cache/.test(text)) {
        rows.set(String(params[0]), { card: JSON.parse(String(params[1])), fetched_at: String(params[2]) }); return { rows: [], rowCount: 1 };
      }
      throw new Error("несподіваний запит: " + text);
    },
  };
}
type Call = { url: string; headers: Record<string, string> };
function fakeFetch(plan: Record<string, number | [number, unknown]>, calls: Call[]) {
  return async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const p = Object.entries(plan).find(([k]) => url.includes(k))?.[1] ?? 404;
    const [status, body] = Array.isArray(p) ? p : [p, null];
    return { status, json: async () => body };
  };
}

/** #1161 — кожен запит — транзакція, тому другий пошук того самого коду в мережу не йде; кешується лише успіх. */
test("#1161 КЕШ ЄДР: другий пошук без мережі, прострочений — знову, 202 і 404 не кешуються, без ПДВ реквізити є", async () => {
  const db = memDb(); const calls: Call[] = [];
  const f = fakeFetch({ "/v1/usr/12345678": [200, LEGAL], "/v1/vat/12345678": 404 }, calls);
  const t0 = new Date("2026-09-30T12:00:00Z");
  const a = await lookupRegistry(db, "12345678", { key: "k", doFetch: f, now: t0 });
  assert.equal(a.kind, "ok"); assert.equal(calls.length, 2, "ЄДР + ПДВ");
  assert.equal(a.kind === "ok" && a.card.ipn, "", "🔴 ПДВ 404 мав дати порожнє поле, а не відмову");
  const b = await lookupRegistry(db, "12345678", { key: "k", doFetch: f, now: new Date(t0.getTime() + 86400000) });
  assert.ok(b.kind === "ok" && b.cached, "🔴 повторний пошук пішов у мережу — витрачено транзакцію");
  assert.equal(calls.length, 2, "🔴 кеш не спрацював");
  await lookupRegistry(db, "12345678", { key: "k", doFetch: f, now: new Date(t0.getTime() + (CACHE_DAYS + 1) * 86400000) });
  assert.equal(calls.length, 4, "🔴 прострочену картку не оновлено");

  const u = await lookupRegistry(db, "1234567890", { key: "k", doFetch: fakeFetch({ "/v1/usr/": 202 }, calls), now: t0 });
  assert.equal(u.kind, "updating"); assert.equal(db.rows.has("1234567890"), false, "🔴 «оновлюється» поклали в кеш");
  const v = await lookupRegistry(db, "11112222", { key: "k", doFetch: fakeFetch({ "/v1/usr/": [200, LEGAL], "/v1/vat/": 202 }, calls), now: t0 });
  assert.equal(v.kind, "updating", "🔴 ПДВ «оновлюється» прочитано як «не платник» — номер губиться на 30 днів");
  assert.equal(db.rows.has("11112222"), false, "🔴 картку без номера ПДВ поклали в кеш");
  const n = await lookupRegistry(db, "99999999", { key: "k", doFetch: fakeFetch({}, calls), now: t0 });
  assert.equal(n.kind, "notFound"); assert.equal(db.rows.has("99999999"), false);
});

/** #1162 — ключ лише в заголовку; ні адреса, ні текст збою, ні картка його не несуть. */
test("#1162 КЛЮЧ ЄДР: лише в заголовку bearer, не в адресі й не в тексті помилки", async () => {
  const KEY = "SECRET-KEY-DO-NOT-LEAK-1234567890";
  const calls: Call[] = [];
  await lookupRegistry(memDb(), "12345678", { key: KEY, doFetch: fakeFetch({ "/v1/usr/": [200, LEGAL] }, calls), now: new Date() });
  assert.equal(calls[0].headers.Authorization, `bearer ${KEY}`);
  assert.ok(calls.every((c) => !c.url.includes(KEY)), "🔴 ключ у адресі запиту — потрапить у логи проксі");
  const boom = async () => { throw new Error(`connect ECONNREFUSED https://api.youscore.com.ua?apiKey=${KEY}`); };
  const r = await lookupRegistry(memDb(), "12345678", { key: KEY, doFetch: boom as never, now: new Date() });
  assert.equal(r.kind, "failed");
  assert.ok(!JSON.stringify(r).includes(KEY), "🔴 текст мережевої помилки з ключем пішов далі");
  const route = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "routes", "constructor.ts"), "utf8");
  assert.doesNotMatch(route, /YOUCONTROL_API_KEY/, "🔴 роут читає ключ сам — він має жити лише в модулі");
});

/** #1163 — без ключа пошук у реєстрі вимкнено чесно: жодного запиту, роут відповідає словами, а не 500. */
test("#1163 БЕЗ КЛЮЧА: жодного запиту в мережу, роут каже «не налаштовано»", async () => {
  const calls: Call[] = [];
  const saved = process.env.YOUCONTROL_API_KEY; delete process.env.YOUCONTROL_API_KEY;
  try {
    const r = await lookupRegistry(memDb(), "12345678", { doFetch: fakeFetch({ "/v1/usr/": [200, LEGAL] }, calls), now: new Date() });
    assert.equal(r.kind, "unconfigured"); assert.equal(calls.length, 0, "🔴 без ключа пішов запит");
  } finally { if (saved !== undefined) process.env.YOUCONTROL_API_KEY = saved; }
  const route = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "routes", "constructor.ts"), "utf8");
  assert.match(route, /r\.kind === "unconfigured"\) throw new HttpError\(404, `[^`]*не налаштовано/, "🔴 без ключа роут не пояснює, чому");
  assert.match(route, /r\.kind === "updating"\) return void res\.status\(202\)/, "🔴 «оновлюється» не віддається як 202");
});
