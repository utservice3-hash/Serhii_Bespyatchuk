import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 🔙 #9225–#9225d — «З КИМ ГОВОРИТИ»: КНОПКА «НАЗАД» І РІВЕНЬ ЕКРАНА В АДРЕСІ (задача 9225, 17.11.2026).
 *
 * Дмитро на РПК 12.11: відкрив менеджера, а повернутись до списку нема як — тільки оновлювати сторінку.
 * Заміряно на проді: шлях назад був (дрібний ланцюжок над лічильниками), але на кнопку не схожий, а вибір
 * команди/менеджера не писав нічого в адресу — «назад» браузера виводив з розділу.
 *
 * Правило рівня — чистий модуль фронту `clientLeadNav.ts`; гейт його ТРАНСПІЛЮЄ Й ВИКОНУЄ (прийом `statsGran`).
 * `#9225d` звіряє джерело: модуль нічого не вартий, якщо екран пише історію через `replaceState` або не слухає
 * `popstate` — тоді правило живе окремо, а «назад» знову виводить з розділу.
 */

const FE = (p: string) => fileURLToPath(new URL(`../../../frontend/src/pages/dashboard/${p}`, import.meta.url));

async function loadNav() {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE("clientLeadNav.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}

test("#9225 ТІМЛІД: команда з адреси ігнорується — завжди своя; менеджер з адреси — лише себе", async () => {
  const { readLeadNav } = await loadNav();
  // ① Тімлід команди 6 з чужим team=3 — бачить СВОЮ команду, а менеджера з адреси відкриває в ній.
  assert.deepEqual(readLeadNav("?tab=lead&team=3&mgr=191", "team_lead", 6), { team: 6, mgr: 191 });
  assert.deepEqual(readLeadNav("?tab=lead", "team_lead", 6), { team: 6, mgr: null });
  // ② Адмін/КВП — команда з адреси читається (дзеркало: інакше «правило» могло б просто різати все).
  assert.deepEqual(readLeadNav("?tab=lead&team=3&mgr=191", "admin", null), { team: 3, mgr: 191 });
  assert.deepEqual(readLeadNav("?tab=lead&team=3&mgr=191", "company", null), { team: 3, mgr: 191 });
  // ③ Менеджер — плаский список, адреса нічого не відкриває.
  assert.deepEqual(readLeadNav("?tab=lead&team=3&mgr=191", "manager", 6), { team: null, mgr: null });
});

test("#9225b СМІТТЯ В АДРЕСІ → РІВЕНЬ «СПИСОК»; коректні id (і «Без команди» = -1) читаються", async () => {
  const { readLeadNav } = await loadNav();
  for (const bad of ["abc", "", "1.5", "1e3", " 7", "7x", "9999999999"]) {
    assert.deepEqual(readLeadNav(`?team=${encodeURIComponent(bad)}&mgr=5`, "admin", null), { team: null, mgr: null }, `team=${bad}`);
    assert.deepEqual(readLeadNav(`?team=3&mgr=${encodeURIComponent(bad)}`, "admin", null), { team: 3, mgr: null }, `mgr=${bad}`);
  }
  // Менеджер без команди не відкривається: у інтерфейсі до нього дійти можна лише через команду.
  assert.deepEqual(readLeadNav("?mgr=191", "admin", null), { team: null, mgr: null });
  // Дзеркало: «Без команди» (-1) — справжня група екрана, і вона мусить відкриватись з адреси.
  assert.deepEqual(readLeadNav("?team=-1&mgr=42", "admin", null), { team: -1, mgr: 42 });
  assert.deepEqual(readLeadNav("?team=12&mgr=7", "admin", null), { team: 12, mgr: 7 });
});

test("#9225c АДРЕСА: інші параметри лишаються, повернення до списку прибирає mgr; кнопка «назад» веде на рівень вище", async () => {
  const { leadNavSearch, backTarget } = await loadNav();
  assert.equal(leadNavSearch("?tab=lead&x=1", { team: 6, mgr: 191 }), "?tab=lead&x=1&team=6&mgr=191");
  assert.equal(leadNavSearch("?tab=lead&team=6&mgr=191", { team: 6, mgr: null }), "?tab=lead&team=6");
  assert.equal(leadNavSearch("?tab=lead&team=6&mgr=191", { team: null, mgr: null }), "?tab=lead");
  // mgr без команди в адресу не пишеться (той самий інваріант, що в читанні).
  assert.equal(leadNavSearch("?tab=lead", { team: null, mgr: 191 }), "?tab=lead");
  assert.equal(leadNavSearch("", { team: null, mgr: null }), "");

  // Кнопка: менеджер → список менеджерів тієї ж команди; адмін на команді → список команд; тімлід на своїй команді — немає.
  assert.deepEqual(backTarget({ team: 6, mgr: 191 }, "team_lead"), { label: "← Назад до списку менеджерів", nav: { team: 6, mgr: null } });
  assert.deepEqual(backTarget({ team: 6, mgr: 191 }, "admin"), { label: "← Назад до списку менеджерів", nav: { team: 6, mgr: null } });
  assert.deepEqual(backTarget({ team: 6, mgr: null }, "admin"), { label: "← Назад до списку команд", nav: { team: null, mgr: null } });
  assert.equal(backTarget({ team: 6, mgr: null }, "team_lead"), null);
  assert.equal(backTarget({ team: null, mgr: null }, "admin"), null);
  assert.equal(backTarget({ team: null, mgr: null }, "manager"), null);
});

test("#9225d ЕКРАН КЛИЧЕ ПРАВИЛО: перехід — pushState, «назад» — popstate, кнопка вгорі й під списком", () => {
  const lead = readFileSync(FE("sections/ClientLeadSection.tsx"), "utf8");
  const loyalty = readFileSync(FE("sections/LoyaltySection.tsx"), "utf8");

  // ① Перехід між рівнями — окремий запис історії, інакше «назад» знову виведе з розділу.
  const goStart = lead.indexOf("const go = useCallback(");
  const goEnd = lead.indexOf("}, [auth.role, auth.teamId]);", goStart);
  assert.ok(goStart >= 0 && goEnd > goStart, "у ClientLeadSection немає функції переходу go (або змінилась її межа)");
  const go = lead.slice(goStart, goEnd);
  assert.match(go, /window\.history\.pushState\(/, "🔴 перехід між рівнями не пише запис історії (pushState)");
  assert.match(go, /leadNavSearch\(/, "🔴 перехід пише адресу не через leadNavSearch");
  // ② Усі входи на рівень ідуть через go — жодного прямого setMgr/setTeam у кліках.
  assert.doesNotMatch(lead, /onClick=\{\(\) => \{? ?set(Mgr|Team)\(/, "🔴 клік міняє рівень повз go — без запису в адресу");
  assert.doesNotMatch(lead, /onPick=\{set(Mgr|Team)\}/, "🔴 вибір у таблиці міняє рівень повз go");
  // ③ «Назад» браузера перечитує рівень і вкладку.
  assert.match(lead, /addEventListener\("popstate", onPop\)/, "🔴 ClientLeadSection не слухає popstate");
  assert.match(lead, /readLeadNav\(window\.location\.search, auth\.role, auth\.teamId\)/, "🔴 рівень не читається з адреси");
  assert.match(loyalty, /addEventListener\("popstate", onPop\)/, "🔴 LoyaltySection не перечитує вкладку на «назад»");
  // ④ Кнопка — і над лічильниками, і під списком клієнтів.
  assert.match(lead, /\{backBtn\}\{crumb\}/, "🔴 немає кнопки «назад» поруч із ланцюжком");
  assert.match(lead, /\{showClients && backBtn && <div>\{backBtn\}<\/div>\}/, "🔴 немає кнопки «назад» під списком клієнтів");
});

test("#9225e КНОПКА «НАЗАД» НЕ ПЛОДИТЬ ІСТОРІЮ: прийшли з того рівня → history.back(); інакше — новий запис", async () => {
  const { backIsHistoryBack } = await loadNav();
  // ① Прийшли зі списку менеджерів команди 6 — кнопка «назад» туди ж: це крок назад в історії.
  assert.equal(backIsHistoryBack({ lead9225: { from: { team: 6, mgr: null } } }, { team: 6, mgr: null }), true);
  // ② Дзеркала: відкрито посиланням (стану немає), чужий стан роутера, прийшли з іншого рівня — новий запис.
  assert.equal(backIsHistoryBack(null, { team: 6, mgr: null }), false);
  assert.equal(backIsHistoryBack({ idx: 3, key: "x" }, { team: 6, mgr: null }), false);
  assert.equal(backIsHistoryBack({ lead9225: { from: { team: null, mgr: null } } }, { team: 6, mgr: null }), false);
  assert.equal(backIsHistoryBack({ lead9225: { from: { team: 6, mgr: 191 } } }, { team: 6, mgr: null }), false);

  // ③ Екран справді кличе це для кнопки, а перехід кладе `from` у стан запису.
  const lead = readFileSync(FE("sections/ClientLeadSection.tsx"), "utf8");
  assert.match(lead, /onClick=\{\(\) => go\(back\.nav, true\)\}/, "🔴 кнопка «назад» не позначає перехід як «назад»");
  assert.match(lead, /if \(back && backIsHistoryBack\(window\.history\.state, nav\)\) \{ window\.history\.back\(\); return; \}/, "🔴 кнопка «назад» не користується history.back()");
  assert.match(lead, /pushState\(\{ lead9225: \{ from \} \}/, "🔴 перехід не запамʼятовує рівень, з якого прийшли");
});
