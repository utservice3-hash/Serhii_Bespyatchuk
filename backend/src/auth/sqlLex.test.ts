import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lexTemplates, queryCallOffsets } from "./sqlLex.js";
import { classifySql, auditSqlDebt, normSql, KNOWN_SQL_DEBT } from "./gates.js";

/**
 * #228 — РОЗБІР SQL-БЛОКІВ. Ворота `#17c` роблять висновок про гроші повз ядро; вони
 * варті рівно стільки, скільки варта їхня здатність ПОБАЧИТИ запит. До 26.08.2026
 * вони бачили 50 із 358, і зелений колір означав «ми не дивились».
 *
 * Усі п'ять — без БД, без мережі, без браузера: скіпатись їм нема від чого, тож у
 * `ALLOWED_PROD_SKIPS` їм робити нічого (DoD 6c).
 */
const ROUTES = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "routes");
const routeFiles = () => readdirSync(ROUTES).filter((f) => f.endsWith(".js") && !f.includes(".test."));
/** Стара регулярка — рівно в тій формі, що стояла до фіксу. Тримаємо для порівняння. */
const OLD_REGEX = (src: string) => [...src.matchAll(/`([^`]{20,8000})`/g)].map((m) => ({ q: m[1], at: m.index ?? 0 }));

test("#228 СКАНЕР · незакрита конструкція КАЖЕ ПРО СЕБЕ, а не мовчить", () => {
  // 🔴 Найгірша відповідь зламаного розбору — «порушень немає». Тому кожна конструкція,
  // що не закрилась до кінця файла, мусить приїхати назвою, а не зникнути.
  assert.deepEqual(lexTemplates("const a = `SELECT 1 FROM deals").unterminated.map((u) => u.kind),
    ["template"], "🔴 незакритий шаблон проковтнуто мовчки");
  // Обидві рамки лишились відкриті — і обидві мусять приїхати, а не лише верхня:
  // «шаблон закрився, а підстановка ні» — це інша поломка, ніж «нічого не закрилось».
  assert.deepEqual(lexTemplates("const a = `x ${ 1 + 2").unterminated.map((u) => u.kind),
    ["template", "substitution"], "🔴 незакрита підстановка проковтнута мовчки");
  assert.deepEqual(lexTemplates("/* коментар без кінця `SELECT`").unterminated.map((u) => u.kind),
    ["comment"], "🔴 незакритий коментар проковтнуто мовчки");
  assert.deepEqual(lexTemplates("const a = 'рядок без кінця").unterminated.map((u) => u.kind),
    ["string"], "🔴 незакритий рядок проковтнуто мовчки");
  // Дзеркало: на здоровому джерелі жодних скарг, інакше гейт червонів би завжди
  // і його вимкнули б через тиждень.
  assert.deepEqual(lexTemplates("const a = `SELECT 1`; const b = 'ok'; /* c */").unterminated, [],
    "🔴 сканер скаржиться на цілком здорове джерело");
});

test("#228b СКАНЕР · регулярний літерал із БЕКТИКОМ не зсуває парність", () => {
  // 📐 Не вигадана форма: `routes/rates.js` містить /[’'`ʼ]/ — регулярку з бектиком
  // усередині. Сканер, що не розрізняє ділення й регулярку, з цього місця читав би
  // решту файла зі зсунутою парністю, і жодна скарга б не пролунала.
  const src = "const apos = /[’'`ʼ]/;\nconst q = `SELECT SUM(d.price) FROM deals d WHERE d.status_id = 142`;\n";
  const got = lexTemplates(src);
  assert.deepEqual(got.unterminated, [], "🔴 бектик усередині регулярки зламав розбір");
  assert.equal(got.blocks.length, 1, "🔴 після регулярки з бектиком зсунулась парність");
  assert.equal(classifySql(got.blocks[0].q), "lifetime");
  // І ділення регуляркою НЕ вважаємо: `a / b` … `c / d` з'їло б усе між ними.
  const div = lexTemplates("const r = total / count; const s = a / b;\nconst q = `SELECT 1 FROM deals x`;\n");
  assert.equal(div.blocks.length, 1, "🔴 ділення прийнято за регулярку — літерал з'їдено");
  // Бектик у КОМЕНТАРІ теж не відкриває літерала — цим файлом рясніє весь проєкт.
  const cmt = lexTemplates("// пишемо в `client_key`, а не в `client_key_raw`\nconst q = `SELECT 1 FROM deals y`;\n");
  assert.equal(cmt.blocks.length, 1, "🔴 бектик у коментарі відкрив «літерал»");
});

test("#228c СКАНЕР · вкладена підстановка лишається ОДНИМ запитом", () => {
  // 🔴 Це і є механізм, що давав 252 промахи: регулярка ріже літерал на внутрішньому
  // бектику, і сума лишається в голові, а фільтр періоду — у хвості. Кожен шматок
  // окремо законний, разом вони — метрика повз ядро.
  // 📐 Форма взята з РЕАЛЬНОГО коду (`${KYIV}` посеред запиту, як у `/repeat-plans-grid`),
  // а не вигадана: підстановка стоїть МІЖ грошовою ознакою і фільтром періоду. Саме це
  // й розводить два сигнали по різних шматках.
  const src = "const q = `SELECT SUM(d.price) AS s FROM deals d WHERE d.status_id = 142 "
            + "${teamAnd ? `AND d.team_id = $9` : \"\"} "
            + "AND (d.closed_at_kommo ${KYIV})::date BETWEEN $1 AND $2`;";
  const blocks = lexTemplates(src).blocks;
  assert.equal(blocks.length, 1, "🔴 вкладена підстановка розколола запит на шматки");
  assert.equal(classifySql(blocks[0].q), "money-period",
    "🔴 цілий запит не впізнано як гроші за період — розбір віддав не те");

  // Доказ, що фікстура моделює МЕХАНІЗМ, а не мою гіпотезу: стара регулярка на ТОМУ
  // САМОМУ вході губить клас. Без цієї половини гейт був би зелений і на зламаному
  // сканері — рівно так ми вже раз «довели» патч на pg-copy-streams.
  const old = OLD_REGEX(src);
  assert.ok(old.every((b) => classifySql(b.q) !== "money-period"),
    "🔴 стара регулярка теж бачить цей запит — отже фікстура НЕ відтворює поломку, "
    + "і зелений колір #228c нічого не доводить");
});

test("#228d ПОКРИТТЯ · розібрано == присутньо (оракул незалежний від сканера)", () => {
  // Оракул — позиція виклику `.query(` з шаблонним аргументом. Її видно простим
  // пошуком, і вона НЕ залежить від того, що сканер каже сам про себе.
  let occ = 0, hit = 0, oldHit = 0;
  const missed: string[] = [];
  for (const f of routeFiles()) {
    const src = readFileSync(path.join(ROUTES, f), "utf8");
    const starts = new Set(lexTemplates(src).blocks.map((b) => b.at));
    const oldStarts = new Set(OLD_REGEX(src).map((b) => b.at));
    for (const at of queryCallOffsets(src)) {
      occ++;
      if (starts.has(at)) hit++; else missed.push(`${f}:${src.slice(0, at).split("\n").length}`);
      if (oldStarts.has(at)) oldHit++;
    }
  }
  assert.ok(occ > 300, `оракул знайшов лише ${occ} викликів .query( — він сам зламався`);
  assert.deepEqual(missed, [],
    `🔴 НЕ ЗМІГ РОЗІБРАТИ: ${occ - hit} із ${occ} запитів не мають блоку на своїй позиції. `
    + "Це не «порушень немає» — це «ми туди не дивились»:\n  " + missed.slice(0, 20).join("\n  "));
  // Доказ, що перевіряти БУЛО ЩО: та сама міра на старій регулярці мусить бути помітно
  // гіршою. Заміряно 26.08.2026: 50 із 358. Якщо колись зрівняється — значить оракул
  // виродився, а не регулярка полагодилась.
  assert.ok(oldHit < occ / 2,
    `🔴 стара регулярка дає ${oldHit} із ${occ} — це не схоже на поломку, яку ми лагодили; `
    + "перевір оракул, перш ніж радіти");
});

test("#228e РЕЄСТР БОРГУ · якорі влучні й живі, мертвий запис червоніє", () => {
  const byFile = new Map<string, string[]>();
  for (const f of routeFiles()) {
    const rel = `routes/${f.replace(/\.js$/, ".ts")}`;
    byFile.set(rel, lexTemplates(readFileSync(path.join(ROUTES, f), "utf8")).blocks.map((b) => normSql(b.q)));
  }
  const real = auditSqlDebt(byFile);
  assert.deepEqual(real.dead, [],
    "🔴 МЕРТВИЙ ЗАПИС У РЕЄСТРІ БОРГУ. Порушення під цим якорем у коді вже немає — "
    + "прибери рядок. Поки він лежить, він глушить СПРАВЖНЄ порушення, що випадково "
    + "збіглося формою:\n  " + real.dead.join("\n  "));
  assert.deepEqual(real.ambiguous, [],
    "🔴 ЯКІР ВЛУЧАЄ У ДВА РІЗНІ ЗАПИТИ — реєстр перестає називати конкретне місце. "
    + "Подовжи якір до фрагмента, який відрізняє їх:\n  " + real.ambiguous.join("\n  "));
  assert.ok(KNOWN_SQL_DEBT.length > 0, "реєстр порожній — аудит нічого не робить");

  // 🧨 Саботаж ВХОДУ, не коду: додаємо запис, під який порушення не існує, і вимагаємо,
  // щоб аудит його назвав. Без цієї половини «dead порожній» означало б лише «функція
  // нічого не вміє».
  const fake = auditSqlDebt(byFile, [...KNOWN_SQL_DEBT, {
    file: "routes/dashboard.ts", anchor: "SELECT ЦЬОГО_ЗАПИТУ_НЕ_ІСНУЄ FROM deals",
    cls: "money-period" as const, route: "GET /вигаданий", why: "саботаж", since: "2026-08-26",
  }]);
  assert.equal(fake.dead.length, 1, "🔴 аудит не бачить мертвого запису — реєстр стане смітником");
  // І дзеркало на неоднозначність: якір у два блоки мусить називатись окремо від мертвого.
  const dup = auditSqlDebt(new Map([["x.ts", ["SELECT a FROM deals", "SELECT a FROM deals b"]]]),
    [{ file: "x.ts", anchor: "SELECT a FROM deals", cls: "lifetime" as never, route: "-", why: "-", since: "-" }]);
  assert.equal(dup.ambiguous.length, 1, "🔴 аудит не бачить якоря, що влучає двічі");
});
