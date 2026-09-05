import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #331 — БАНДЛ МУСИТЬ НЕСТИ СВОЮ SHA, інакше плашка «вийшла нова версія» мертва
 * за побудовою, а гейти на самому правилі (#330*) лишаються зеленими.
 *
 * 🔴 ЦЕ НЕ ДУБЛЮВАННЯ #330. Ті троє перевіряють ПРАВИЛО (`clientStale`): якщо дати
 * йому дві різні sha, він скаже «стара». Цей перевіряє, що фронту Є ЩО ДАТИ.
 * Розрив між ними — рівно та дірка, через яку фіча вмирає тихо: досить прибрати
 * `define` з `frontend/vite.config.ts` (одна правка конфіга, ніяк не повʼязана з
 * плашкою на вигляд), і бандл почне слати порожнечу. Правило чесно відповість
 * `null` = «не знаю», плашки не буде НІКОЛИ, і жоден інший гейт цього не помітить:
 * `#42` порівнює версії сервера, `#225` рахує чанки, CSS-guard дивиться на стилі.
 *
 * 📐 Той самий клас, що заміряний 26.08.2026 на `.env.production`: бандл виходив
 * робочим на вигляд і мертвим по суті, а різниця — кілька байтів у мініфікованому
 * рядку. Тому гейт дивиться на АРТЕФАКТ, який отримує браузер, а не на конфіг.
 *
 * ⚠️ Шукаємо не імʼя `__BUILD_SHA__` — vite підставляє значення на збірці, тож
 * ідентифікатора в бандлі не існує. Шукаємо ЛІТЕРАЛ: рядок із 40 hex-символів.
 */

interface Bundle { file: string; src: string }

/** Спершу ДОКРУТ (те, що Apache віддає людям), потім `frontend/dist` (стенд/свіжа збірка). */
function bundles(): Bundle[] {
  const roots = [
    fileURLToPath(new URL("../../assets", import.meta.url)),
    fileURLToPath(new URL("../../frontend/dist/assets", import.meta.url)),
  ];
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    const js = readdirSync(dir).filter((f) => /^index-.*\.js$/.test(f));
    if (js.length) return js.map((f) => ({ file: path.join(dir, f), src: readFileSync(path.join(dir, f), "utf8") }));
  }
  return [];
}

/**
 * 🔴 У `ALLOWED_PROD_SKIPS` НЕ вноситься СВІДОМО — рівно з тієї ж причини, що й
 * `#225c`: у `test:prod` докрут існує завжди, тож порожня видача там означає не
 * «нема чим перевіряти», а справжній дефект.
 */
const NO_BUNDLE = "немає зібраного бандла: ні assets/ докрута, ні frontend/dist/assets — "
  + "у test:prod це ПАДІННЯ (там докрут є завжди), у npm test на свіжому клоні це норма";

/** Рівно те, що вміє прочитати `clientStale`: 40 hex у лапках, як літерал у JS. */
const SHA_LITERAL = /["'`][0-9a-f]{40}["'`]/i;

test("#331 БАНДЛ НЕСЕ SHA СВОЄЇ ЗБІРКИ", (t) => {
  const bs = bundles();
  if (!bs.length) return t.skip(NO_BUNDLE);
  for (const b of bs) {
    assert.ok(
      SHA_LITERAL.test(b.src),
      `${path.basename(b.file)}: у бандлі немає 40-символьної sha. Отже фронт шле `
      + `порожнечу, сервер чесно відповідає «не знаю», і плашка «вийшла нова версія» `
      + `не зʼявиться НІКОЛИ — при зелених #330/#330b/#330c. Найімовірніша причина: `
      + `зник \`define: { __BUILD_SHA__ }\` у frontend/vite.config.ts.`,
    );
  }
});

test("#331b 🪞 ДЗЕРКАЛО: «unknown» замість sha — це НЕ збірка з версією", (t) => {
  const bs = bundles();
  if (!bs.length) return t.skip(NO_BUNDLE);
  /**
   * Без дзеркала #331 зеленів би на бандлі, зібраному БЕЗ git (де `define` чесно
   * підставив `"unknown"`), якби 40-hex випадково трапився деінде — у хеші
   * бібліотеки, у мапі джерел, у чужому літералі. Тут перевіряємо навпаки: рівно
   * той рядок, який ми самі підставляємо як «не знаю», у прод-бандлі бути не має.
   *
   * ⚠️ Шукаємо в лапках, а не голе слово: «unknown» трапляється в чужому коді
   * (повідомлення помилок бібліотек), і гейт на підрядок був би шумом, а не сторожем.
   */
  for (const b of bs) {
    assert.equal(
      /["'`]unknown["'`]\s*[,;)\]]/.test(b.src) && !SHA_LITERAL.test(b.src), false,
      `${path.basename(b.file)}: бандл несе «unknown» і не несе sha — його зібрали `
      + `там, де git недоступний. Такий бандл ніколи не дізнається, що застарів.`,
    );
  }
});
