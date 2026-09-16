import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #447 — КОЖЕН ВИДИМИЙ ПУНКТ МЕНЮ МАЄ БЛОК РЕНДЕРА.
 *
 * 🔴 ДІРКА, ЯКУ ЗАКРИВАЄ ЦЕЙ ГЕЙТ, — ТИХА. Ключ у `NAV_GROUPS` робить URL валідним сам
 * по собі (`Dashboard.tsx` визнає секцію лише за присутністю в `NAV_ITEMS`), а рендер —
 * це окремий блок `{section === "<key>" && …}` у тому ж файлі. Забув блок — пункт меню
 * клікається, адреса відкривається, а сторінка ПОРОЖНЯ. Ні помилки, ні 404, ні червоного
 * гейта: до 16.09.2026 цю повноту не звіряло НІЩО (перевірено розвідкою по `backend/src`,
 * `tools`, `qa`). Порожня сторінка читається як «даних немає», а не як «екран не підключено».
 *
 * ⚠️ `HIDDEN_NAV` звільнений СВІДОМО, і з причиною: прихований ключ вилучений із `NAV_ITEMS`,
 * тобто його URL редіректить на `/` — порожньої сторінки він дати не може. Заміряно
 * 16.09.2026: із 29 ключів без блоку рендера рівно один — `ads`, і він прихований законно
 * (ключ дозволу; екран живе вкладкою всередині «Статистик»).
 */

const ROOTS = [
  path.join(import.meta.dirname, "..", ".."),
  path.join(import.meta.dirname, "..", "..", ".."),
  path.join(import.meta.dirname, "..", "..", "..", ".."),
];
function readSrc(rel: string): string {
  for (const r of ROOTS) {
    try { return readFileSync(path.join(r, rel), "utf8"); } catch { /* далі */ }
  }
  assert.fail(`не знайдено ${rel} — перевірка не має права мовчки пропускатись`);
}

/**
 * Чисте правило: які ВИДИМІ ключі меню не мають блоку рендера.
 * Межі змістові, а не за довжиною: зріз між двома маркерами-оголошеннями, які вже
 * стереже `#306` (перейменування будь-якого з них там червоніє першим).
 */
export function navKeysWithoutRender(layoutSrc: string, dashSrc: string): { visible: string[]; missing: string[] } {
  const start = layoutSrc.indexOf("export const NAV_GROUPS");
  const end = layoutSrc.indexOf("export type NavKey");
  assert.ok(start >= 0 && end > start, "🔴 не знайшов межі NAV_GROUPS — розбір осліп би мовчки");
  const nav = layoutSrc.slice(start, end);
  const keys = [...nav.matchAll(/key:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
  const hidM = /HIDDEN_NAV[^=]*=\s*new Set[^(]*\(\[([^\]]*)\]/.exec(layoutSrc);
  const hidden = new Set(hidM ? [...hidM[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]) : []);
  const visible = keys.filter((k) => !hidden.has(k));
  const missing = visible.filter((k) => !new RegExp(`section\\s*===\\s*"${k.replace(/-/g, "\\-")}"`).test(dashSrc));
  return { visible, missing };
}

test("#447 КОЖЕН ВИДИМИЙ ПУНКТ МЕНЮ МАЄ БЛОК РЕНДЕРА — інакше порожня сторінка мовчки", () => {
  const { visible, missing } = navKeysWithoutRender(
    readSrc(path.join("frontend", "src", "components", "Layout.tsx")),
    readSrc(path.join("frontend", "src", "pages", "Dashboard.tsx")),
  );
  // 🔴 ПОРОЖНІЙ РОЗБІР — ПРОВАЛ, А НЕ «УСІ МАЮТЬ РЕНДЕР». Якщо регулярка перестане бачити
  // ключі, `missing` стане порожнім і гейт позеленіє саме тоді, коли нічого не перевіряє.
  assert.ok(visible.length >= 10,
    `🔴 розібрано лише ${String(visible.length)} видимих ключів — розбір NAV_GROUPS зламався`);
  assert.ok(visible.includes("missed-calls"),
    "🔴 розбір не бачить «missed-calls» — отже або ключ зник із меню, або регулярка сліпа");
  assert.deepEqual(missing, [],
    `🔴 пункти меню БЕЗ блоку рендера в Dashboard.tsx: ${missing.join(", ")}. `
    + "Людина клікне й побачить порожню сторінку без жодної помилки.");
});

test("#447b ДЗЕРКАЛО: правило ловить відсутній рендер, пускає наявний і звільняє прихований", () => {
  const layout = `export const NAV_GROUPS = [ { items: [
      { key: "alpha", label: "A", icon: "x" },
      { key: "beta-gamma", label: "B", icon: "x" },
      { key: "hidden-one", label: "H", icon: "x" },
    ] } ] as const;
    export type NavKey = string;
    const HIDDEN_NAV: ReadonlySet<string> = new Set<string>(["hidden-one"]);`;

  // По один бік межі — рендер є в обох видимих: порожньо.
  const full = navKeysWithoutRender(layout, `{section === "alpha" && <A/>} {section === "beta-gamma" && <B/>}`);
  assert.deepEqual(full.missing, [], "🔴 правило вигадало відсутність там, де рендер є");

  // По другий — рендер одного видимого прибрано: мусить назвати САМЕ його.
  const broken = navKeysWithoutRender(layout, `{section === "alpha" && <A/>}`);
  assert.deepEqual(broken.missing, ["beta-gamma"], "🔴 правило не помітило пункт меню без рендера");

  // Прихований без рендера — законно, бо його URL редіректить на «/».
  assert.ok(!full.visible.includes("hidden-one"), "🔴 прихований ключ вважається видимим");

  // Ключ через дефіс не мусить збігтися з сусідом-префіксом: «alpha» ≠ «alpha-two».
  const prefix = navKeysWithoutRender(
    `export const NAV_GROUPS = [{ items: [{ key: "alpha-two", label: "x", icon: "x" }] }];
     export type NavKey = string; const HIDDEN_NAV = new Set<string>([]);`,
    `{section === "alpha-two-extra" && <X/>}`);
  assert.deepEqual(prefix.missing, ["alpha-two"], "🔴 рендер сусіда з довшою назвою зарахувався як свій");
});
