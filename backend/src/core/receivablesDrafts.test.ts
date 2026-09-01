import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ✍️ #251–#251b — ВТРАТА НАБРАНОГО ТЕКСТУ НА ЕКРАНІ ДЕБІТОРКИ.
 *
 * 📐 Заміряно 01.09.2026 за скаргою власника «коли додаємо замітки або робимо
 * редагування, воно автоматично оновлюється». Екран перечитується сам: раз на
 * 300 000 мс ±25% (`usePolling`, тобто 225 000-375 000) і НЕГАЙНО при поверненні
 * фокуса на вкладку — а людина звіряє борг у 1С поруч, тож це щоразу.
 *
 * Втрату давали два різні механізми, і обидва тут:
 *   ① ключ рядка містив ІНДЕКС у відсортованому списку → після рефетчу рядок
 *     переїжджав, React розмонтовував його разом із відкритим редактором;
 *   ② `CommentField` затирав чернетку будь-якою зміною зовнішнього значення.
 *
 * ⚠️ МЕЖА, НАЗВАНА ВГОЛОС: DOM-харнеса в проєкті немає (ні jsdom, ні
 * testing-library, ні vitest), тож РЕНДЕР компонента перевірити нічим. Гейти
 * б'ють по чистих предикатах, які ці рішення й приймають, — і саме тому рішення
 * винесені у `.ts`, а не лишились усередині `.tsx`. Це поведінка, а не текст
 * файла, але це НЕ спостереження за живим React.
 */

const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
const FE_SPEC = (p: string) => srcOf(`../../../frontend/src/${p}`);
const FE = (p: string) => readFileSync(FE_SPEC(p), "utf8");

test("#251 ключ рядка дебіторки не залежить від позиції — редактор переживає пересортування", async () => {
  const { receivableRowKey } = await import(FE_SPEC("pages/dashboard/receivablesView.ts"));

  // Той самий склад, ІНШИЙ порядок — так виглядає список після рефетчу,
  // бо сортування дефолтне за сумою спадно, а суми міняє синк із 1С.
  const before = [{ clientKey: "смартекс" }, { clientKey: "автострадавк" }, { clientKey: "мгер" }];
  const after = [{ clientKey: "автострадавк" }, { clientKey: "мгер" }, { clientKey: "смартекс" }];

  for (const c of before) {
    const k1 = receivableRowKey(c);
    const k2 = receivableRowKey(after.find((x) => x.clientKey === c.clientKey)!);
    assert.equal(k1, k2,
      `🔴 ключ клієнта «${c.clientKey}» змінився від пересортування: ${k1} → ${k2}.\n` +
      "   React вважатиме це ІНШИМ рядком, розмонтує його разом із відкритим редактором\n" +
      "   домовленості, і набраний текст зникне без сліду.");
  }

  // 🪞 ДЗЕРКАЛО: ключі мусять лишатись РІЗНИМИ, інакше React склеїть рядки.
  const keys = before.map(receivableRowKey);
  assert.equal(new Set(keys).size, keys.length, `🔴 ключі не унікальні: ${keys.join(", ")}`);

  // І виклик у розмітці справді йде через цю функцію, а не через власний вираз.
  const sec = FE("pages/dashboard/sections/ReceivablesSection.tsx");
  assert.match(sec, /<RowBoundary key=\{receivableRowKey\(c\)\}/,
    "🔴 рядок будує ключ власним виразом. Саме так там і опинився індекс `i`.");
  assert.ok(!/key=\{`\$\{c\.clientKey\}-\$\{i\}`\}/.test(sec),
    "🔴 індекс повернувся в ключ рядка");
});

test("#251b поле коментаря не затирає БРУДНУ чернетку, але ЧИСТЕ підхоплює", async () => {
  const { adoptsExternal } = await import(FE_SPEC("components/commentDraft.ts"));

  // ① Головне: людина набрала й не зберегла (збереження на blur) — зовнішнє чекає.
  assert.equal(adoptsExternal(true, "з сервера", "я саме набираю"), false,
    "🔴 зовнішнє значення затерло незбережену чернетку — це і є втрата роботи,\n" +
    "   на яку скаржився власник: до неї достатньо, щоб список перечитався під час набору.");

  // ② 🪞 ДЗЕРКАЛО, без якого фікс перетворює поле на мертве: чисте поле ОНОВЛЮЄТЬСЯ.
  assert.equal(adoptsExternal(false, "з сервера", "старе"), true,
    "🔴 чисте поле більше не підхоплює зовнішнє значення — чужу правку буде видно\n" +
    "   лише після перезавантаження сторінки. Односторонній фікс гірший за дефект.");

  // ③ Дрібниці, що тримають предикат чесним.
  assert.equal(adoptsExternal(false, "те саме", "те саме"), false, "🔴 зайве оновлення при однакових значеннях");
  assert.equal(adoptsExternal(true, "те саме", "те саме"), false, "🔴 брудне поле чіпається навіть без зміни");

  // ④ І компонент справді питає предикат, а не має власну копію умови.
  const cf = FE("components/CommentField.tsx");
  assert.match(cf, /\badoptsExternal\b(?!\w)\s*\(/,
    "🔴 CommentField не кличе adoptsExternal — умова живе копією й розійдеться з гейтом");
  assert.ok(!/useEffect\(\(\) => \{ setV\(value \?\? ""\); \}, \[value\]\)/.test(cf),
    "🔴 повернувся беззастережний setV на кожну зміну value — саме він і затирав чернетку");
  assert.match(cf, /dirty\.current = true/, "🔴 набір тексту більше не позначає чернетку брудною");
  assert.match(cf, /dirty\.current = false/, "🔴 збереження не скидає прапорець — поле застрягне брудним назавжди");
});
