import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 🗺 #260–#260b — КАРТА ЗОН У КОРЕНІ НЕ МОЖЕ БРЕХАТИ МОВЧКИ.
 *
 * 🔴 ЩО САМЕ СТЕРЕЖЕТЬСЯ. 31.08.2026 зміст `CLAUDE.md` розклали за зонами
 * (`.claude/rules/*.md`), а в корені лишили КАРТУ — таблицю «домен → адреса». Карта
 * і є той механізм, яким наступний чат знаходить правило своєї зони. Отже вона —
 * перелік, а **перелічувач має власну сліпу зону: файл**. Правило перейменували —
 * карта показує в порожнечу; правило додали — карти на нього немає, і зона мовчки
 * невидима. Обидві поломки тихі, бо жоден інший гейт документацію не читає.
 *
 * 🔴 ЧОМУ ПЕРЕВІРКА ДВОБІЧНА, І ДРУГА ПОЛОВИНА ВАЖЛИВІША. «Кожна адреса існує» —
 * зелене й тоді, коли карта називає ОДНЕ правило з тринадцяти. Саме «додав правило
 * й забув карту» — очікуваний спосіб зламати це, бо він трапляється сам собою при
 * звичайній роботі. Тому рівність множин, а не включення.
 *
 * 🔴 ГЕЙТ СТОЇТЬ НА ВИВОДІ, А НЕ НА ТІЛІ КРОКУ. Він читає ТЕКСТ таблиці з `CLAUDE.md`
 * — рівно те, що бачить людина, — а не константу в коді, яка «мала б» його породити.
 * Твердження через проксі падає від рефакторингу й мовчить від дефекту; тут дефект
 * саме в тексті, тож і дивитись треба в текст.
 *
 * ⚠️ ПОРОЖНІЙ СКОУП НЕ ВИРАЖАЄТЬСЯ НУЛЕМ. Якщо розділ карти перейменують, витягач
 * поверне порожню множину — і рівність «нуль == нуль» була б зеленою при зниклій
 * карті. Тому мінімальна потужність перевіряється ОКРЕМИМ твердженням і першим.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAP_HEADING = "## 🗺 КАРТА ЗОН";
const RULES_DIR = `${ROOT}.claude/rules`;

/** Текст РІВНО того розділу, який читає людина. Порожньо = карти немає. */
export function mapSection(claudeMd: string): string {
  const from = claudeMd.indexOf(MAP_HEADING);
  if (from < 0) return "";
  const next = claudeMd.indexOf("\n## ", from + MAP_HEADING.length);
  return next < 0 ? claudeMd.slice(from) : claudeMd.slice(from, next);
}

/** Адреси, НАЗВАНІ в тексті карти (без дублів, у порядку появи). */
export function addressesIn(section: string): string[] {
  const re = /\.claude\/(?:rules\/[A-Za-z0-9._-]+\.md|skills\/[A-Za-z0-9._-]+\/SKILL\.md)/g;
  return [...new Set(section.match(re) ?? [])];
}

/** Розбіжність між картою й диском — обидва боки одразу, бо одного боку замало. */
export function zoneDiff(named: string[], onDisk: string[]): { missing: string[]; unmapped: string[] } {
  const n = new Set(named), d = new Set(onDisk);
  return {
    missing: [...d].filter((f) => !n.has(f)).sort(),   // правило є, карти на нього немає
    unmapped: [...n].filter((f) => !d.has(f)).sort(),  // карта називає те, чого немає
  };
}

test("#260 карта зон у CLAUDE.md збігається з .claude/rules у ОБИДВА боки", () => {
  const section = mapSection(readFileSync(`${ROOT}CLAUDE.md`, "utf8"));
  assert.ok(section.length > 0,
    `🔴 у CLAUDE.md немає розділу «${MAP_HEADING}» — карта зон зникла, і наступний чат не знайде правил своєї зони.`);

  const named = addressesIn(section);
  // Порожній скоуп — ПРОВАЛ, а не «нічого перевіряти»: інакше рівність нуля з нулем зеленіла б.
  assert.ok(named.length >= 10,
    `🔴 у карті названо лише ${named.length} адрес — таблиця зникла або перестала бути машиночитною; перевіряти було нічого.`);

  const onDisk = readdirSync(RULES_DIR).filter((f) => f.endsWith(".md")).map((f) => `.claude/rules/${f}`);
  const { missing, unmapped } = zoneDiff(named, onDisk);

  // 🔴 Твердження і текст падіння беруться з ОДНОГО набору. Перша редакція звіряла
  // відфільтрований список, а називала повний — і саботаж S1 показав у червоному
  // `.claude/skills/deploy/SKILL.md`, який насправді на місці. Підпис, що стверджує
  // причину, не може називати невинного: читач пішов би шукати неіснуючу поломку.
  const badRules = unmapped.filter((a) => a.startsWith(".claude/rules/"));
  assert.deepEqual(badRules, [],
    `🔴 карта називає правила, яких на диску НЕМАЄ: ${badRules.join(", ")}. Перейменували файл — карта показує в порожнечу.`);
  assert.deepEqual(missing, [],
    `🔴 правила є, а в карті вони НЕ названі: ${missing.join(", ")}. Зона мовчки невидима — саме так «додав правило й забув карту» і виглядає.`);

  // Адреси поза `rules/` (скіл) карта теж називає — вони мусять існувати як файли.
  for (const a of named.filter((x) => !x.startsWith(".claude/rules/")))
    assert.ok(existsSync(`${ROOT}${a}`), `🔴 карта називає «${a}», але такого файла немає.`);
});

test("#260b ДЗЕРКАЛО: витягач і звірка справді ловлять обидві поломки, а цілу карту пропускають", () => {
  // Приклад по ОБИДВА боки межі — інакше доведено було б лише «функція щось повертає».
  assert.equal(mapSection("# без карти\n\n## інше\nтекст"), "", "🔴 відсутню карту витягач мав віддати порожнечею");
  assert.ok(mapSection(`${MAP_HEADING} x\nрядок\n## далі`).includes("рядок"), "🔴 витягач не бачить тіла наявної карти");
  assert.equal(addressesIn("жодної адреси тут немає").length, 0, "🔴 адреси знайдено там, де їх немає");

  const disk = [".claude/rules/a.md", ".claude/rules/b.md"];
  assert.deepEqual(zoneDiff(disk, disk), { missing: [], unmapped: [] }, "🔴 ціла карта мусить давати порожню розбіжність");
  assert.deepEqual(zoneDiff([".claude/rules/a.md"], disk).missing, [".claude/rules/b.md"],
    "🔴 «правило є, карти немає» не спіймано — це і є та половина, заради якої перевірка двобічна");
  assert.deepEqual(zoneDiff([".claude/rules/a.md", ".claude/rules/zzz.md"], disk).unmapped, [".claude/rules/zzz.md"],
    "🔴 «карта називає неіснуюче» не спіймано");
});
