import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * #39 — КОЖНА ДІЯ КЕРУВАННЯ МАЄ ЖИВИЙ ВХІД В UI, А НЕ ЛИШЕ РОУТ.
 *
 * 🔴 ЧОМУ ЦЕ ГЕЙТ, А НЕ УВАЖНІСТЬ. Той самий клас упіймано ВДРУГЕ за тиждень:
 *   · 04.08.2026 — «🗑 прибрати з постійних»: роут живий, входу в UI немає;
 *   · 05.08.2026 — та сама кнопка повернулась у картку, але після хвилі 2 слала
 *     `{clientKey, hidden}`, якого роут уже НЕ пише. Тобто вхід був, а дії не
 *     було: 200 у відповідь, нуль змін у БД. Мовчазна кнопка гірша за відсутню —
 *     людина вважає, що зробила роботу.
 * Двічі — це вже не випадковість, а спосіб, у який ми ламаємо саме цей код.
 *
 * 🪞 ЩО ЦЕЙ ГЕЙТ ЛОВИТЬ, А ЧОГО НІ — сказано вголос, щоб на нього не покладались
 * ширше, ніж він тримає:
 *   ✅ ловить: роут без жодного виклику з UI; виклик із файлу, який нізвідки не
 *      імпортується (мертвий компонент); зникнення хелпера з `api.ts`.
 *   ❌ НЕ ловить: «кнопка є, але захована внизу сторінки під таблицею на 610
 *      рядків» — це видимість, а не існування. Її перевіряє тільки погляд на
 *      екран (правило приймання екранів у CLAUDE.md).
 *   ❌ НЕ ловить: чи роут робить те, що обіцяє кнопка. Для конкретного випадку
 *      `hidden` це закриває окрема перевірка нижче.
 */

const FE = path.resolve(process.cwd(), "../frontend/src");

/**
 * Реєстр дій керування: роут ↔ функція-хелпер в `api.ts`.
 * Додав роут керування — додай рядок; інакше він лишиться «зелений там, куди ми
 * не дивились», рівно як ендпоінт без запису в `accessMatrix`.
 */
const MANAGEMENT_ACTIONS: { route: string; helper: string; what: string }[] = [
  { route: "/dashboard/client-merge", helper: "mergeClients", what: "обʼєднати клієнтів" },
  { route: "/dashboard/client-merge/revoke", helper: "revokeMerge", what: "роз'єднати" },
  { route: "/dashboard/client-merge/preview", helper: "fetchMergePreview", what: "передпоказ обʼєднання" },
  { route: "/dashboard/client-merge/journal", helper: "fetchMergeJournal", what: "журнал обʼєднань" },
  { route: "/dashboard/client-manager", helper: "assignClientManager", what: "передати відповідального" },
  { route: "/dashboard/client-manager/history", helper: "fetchClientManagerHistory", what: "історія передач" },
  { route: "/dashboard/client-archive", helper: "archiveClient", what: "в архів / з архіву" },
  { route: "/dashboard/client-search", helper: "fetchClientSearch", what: "пошук клієнта для форм" },
  { route: "/dashboard/orphan-clients/claim", helper: "claimOrphanClient", what: "взяти нічийного" },
];

const read = (p: string) => fs.readFileSync(p, "utf-8");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
};

/** Файли, досяжні за імпортами від кореня застосунку. Мертвий компонент сюди не потрапить. */
function reachableFiles(): Set<string> {
  const seen = new Set<string>();
  const resolve = (from: string, spec: string): string | null => {
    if (!spec.startsWith(".")) return null;
    const base = path.resolve(path.dirname(from), spec);
    for (const c of [`${base}.tsx`, `${base}.ts`, path.join(base, "index.tsx"), path.join(base, "index.ts")])
      if (fs.existsSync(c)) return c;
    return null;
  };
  const visit = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const m of read(f).matchAll(/from\s+["']([^"']+)["']/g)) {
      const t = resolve(f, m[1]);
      if (t) visit(t);
    }
  };
  for (const root of ["main.tsx", "App.tsx"]) {
    const p = path.join(FE, root);
    if (fs.existsSync(p)) visit(p);
  }
  return seen;
}

test("#39 ВХІД В UI: кожна дія керування викликається з ДОСЯЖНОГО компонента", () => {
  const api = read(path.join(FE, "api.ts"));
  const reachable = reachableFiles();

  // 🪞 НЕВИРОДЖЕНІСТЬ ОБХОДУ. Якби resolve зламався, `reachable` став би майже
  // порожнім — і тоді ВСІ дії чесно провалились би, але з неправильної причини.
  // Тому спершу доводимо, що обхід узагалі щось знайшов.
  assert.ok(reachable.size > 30,
    `🔴 обхід імпортів знайшов лише ${reachable.size} файлів — зламався сам обхід, `
    + "а не дії керування (порожній результат це ПРОВАЛ, не успіх)");

  const tsx = walk(FE).filter((f) => f.endsWith(".tsx"));
  const missing: string[] = [];
  for (const a of MANAGEMENT_ACTIONS) {
    // 1 · реєстр не має розходитись із `api.ts`
    assert.ok(new RegExp(`\\b${a.helper}\\b`).test(api),
      `🔴 хелпер «${a.helper}» (${a.what}) зник із api.ts — реєстр протух`);
    assert.ok(api.includes(a.route),
      `🔴 роут ${a.route} не згадується в api.ts — дія недосяжна з фронту взагалі`);

    // 2 · його хтось кличе, і цей хтось досяжний від кореня
    const callers = tsx.filter((f) => new RegExp(`\\b${a.helper}\\s*\\(`).test(read(f)));
    const live = callers.filter((f) => reachable.has(f));
    if (live.length === 0)
      missing.push(callers.length === 0
        ? `${a.route} (${a.what}) — жоден компонент не викликає «${a.helper}»`
        : `${a.route} (${a.what}) — «${a.helper}» кличуть лише НЕДОСЯЖНІ файли: `
          + callers.map((f) => path.relative(FE, f)).join(", "));
  }
  assert.deepEqual(missing, [],
    "🔴 дії керування без живого входу в UI:\n  " + missing.join("\n  "));
});

test("#39b МЕРТВЕ ПОЛЕ `hidden` НЕ ЖИВЕ У ФРОНТІ (той самий баг не повернеться тихо)", () => {
  // 🔴 Конкретика, а не загальне правило: після хвилі 2 роут `/loyalty-override`
  // поле `hidden` НЕ пише. Кнопка, що його шле, виглядає робочою і не робить
  // нічого. Загальний #39 цього не побачить — там вхід ІСНУЄ.
  const overrideCore = read(path.resolve(process.cwd(), "src/core/loyaltyOverride.ts"));
  assert.ok(!/\bhidden\s*=|\bhidden\b\s*,\s*\$\d/.test(overrideCore),
    "🔴 `hidden` знову пишеться в loyaltyOverride — тоді цей гейт треба переглянути, "
    + "а не обходити");

  const offenders: string[] = [];
  for (const f of walk(FE).filter((x) => x.endsWith(".tsx"))) {
    const src = read(f);
    if (/saveLoyaltyOverride\s*\(\s*\{[^}]*\bhidden\b/s.test(src)) offenders.push(path.relative(FE, f));
  }
  assert.deepEqual(offenders, [],
    "🔴 фронт шле `hidden` у /loyalty-override, а роут його НЕ пише — кнопка мовчки "
    + "нічого не робить (200 і нуль змін). Це рівно той баг, що вже був: " + offenders.join(", "));
});
