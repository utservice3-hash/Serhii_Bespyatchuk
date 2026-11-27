import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLIENT_COMPANIES_SQL, KOMMO_LINKS_MAX, kommoLinksOf, type CompanyRow } from "./clientKommoLinks.js";

/**
 * 🔗 #11244 — КАРТКА КЛІЄНТА ВЕДЕ В KOMMO (Роман 27.11.2026: «хочеться щоб можна було перейти на карточку клієнта в коммо
 * через дашборд, додай якось гарно»).
 *
 * Твердження: (1) є компанії — показуємо ЇХ УСІ в порядку запиту, не більше `KOMMO_LINKS_MAX`, а решту називаємо числом;
 * контакт і угода тоді не підмішуються; (2) компаній немає — рівно одне посилання: контакт, а без контакту угода;
 * (3) нічого немає — порожньо, і блок на екрані не малюється; (4) проводка: роут картки кличе модуль і будує адресу
 * за видом цілі, панель картки малює блок, посилання відкриваються в новій вкладці, і про «компанію не прикріплено»
 * екран мовчить (звʼязки в базі неповні за горизонтом бекфілу — правило зони clients, 06.08.2026).
 * 🧨 Червоніє, якщо обрізати компанії мовчки, підмішати контакт до компаній, прибрати фолбек на угоду, зняти виклик
 * із роута чи блок із картки.
 */
const ROUTE = fileURLToPath(new URL("../../src/routes/dashboard.ts", import.meta.url));
const FE = (f: string): string => fileURLToPath(new URL(`../../../frontend/src/pages/dashboard/sections/${f}`, import.meta.url));
const co = (id: number, name: string | null, deals: number): CompanyRow => ({ company_id: String(id), name, deals });

test("#11244 КАРТКА КЛІЄНТА → KOMMO: усі компанії клієнта (решта числом), інакше контакт, інакше угода; роут і картка проведені", () => {
  // (1) компанії: всі, у порядку запиту, назва обрізана від пробілів, порожня назва — null (екран підпише сам)
  const two = kommoLinksOf([co(11, " Алварк ", 7), co(12, "", 1)], { contactId: 5, dealId: 9 });
  assert.deepEqual(two, { targets: [
    { kind: "company", id: 11, name: "Алварк", deals: 7 },
    { kind: "company", id: 12, name: null, deals: 1 }], more: 0 }, "🔴 компанії клієнта подано не всі або не в порядку запиту");
  assert.ok(two.targets.every((t) => t.kind === "company"), "🔴 до компаній підмішано контакт чи угоду");

  // межа з обох боків: рівно MAX — без «ще», MAX + 2 — показано MAX і названо 2
  const many = (n: number) => Array.from({ length: n }, (_, i) => co(100 + i, `К${String(i)}`, n - i));
  assert.equal(kommoLinksOf(many(KOMMO_LINKS_MAX), { contactId: null, dealId: null }).more, 0, "🔴 «ще N» зʼявилось, хоча вмістились усі");
  const over = kommoLinksOf(many(KOMMO_LINKS_MAX + 2), { contactId: null, dealId: null });
  assert.equal(over.targets.length, KOMMO_LINKS_MAX, "🔴 показано більше компаній, ніж межа картки");
  assert.equal(over.more, 2, "🔴 компанії, що не вмістились, обрізано мовчки");
  assert.deepEqual(over.targets.map((t) => t.id), [100, 101, 102, 103, 104], "🔴 обрізано не хвіст, а початок (свіжі компанії)");

  // (2) без компаній: контакт, а без нього угода — рівно одне посилання
  assert.deepEqual(kommoLinksOf([], { contactId: 5, dealId: 9 }), { targets: [{ kind: "contact", id: 5, name: null, deals: null }], more: 0 },
    "🔴 без компанії картка не веде на контакт");
  assert.deepEqual(kommoLinksOf([], { contactId: null, dealId: 9 }), { targets: [{ kind: "deal", id: 9, name: null, deals: null }], more: 0 },
    "🔴 без компанії й контакту клік мертвий — фолбек на угоду зник");
  // (3) нічого
  assert.deepEqual(kommoLinksOf([], { contactId: null, dealId: null }), { targets: [], more: 0 });

  // запит: канонічний ключ клієнта, свіжа компанія першою
  assert.match(CLIENT_COMPANIES_SQL, /WHERE d\.client_key = \$1/, "🔴 компанії шукаються не за канонічним ключем клієнта");
  assert.match(CLIENT_COMPANIES_SQL, /ORDER BY last_at DESC NULLS LAST/, "🔴 свіжа компанія більше не перша");

  // (4) проводка роута: модуль викликано в /client-card, адреса — за видом цілі
  const route = readFileSync(ROUTE, "utf8");
  const card = route.slice(route.indexOf('dashboardRouter.get("/client-card"'));
  const body = card.slice(0, card.indexOf("\ndashboardRouter.", 10));
  assert.match(body, /await clientKommoTargets\(clientKey\)/, "🔴 роут картки не кличе clientKommoTargets");
  assert.match(body, /t\.kind === "company" \? kommoCompanyUrl\(t\.id\) : t\.kind === "contact" \? kommoContactUrl\(t\.id\) : kommoLeadUrl\(t\.id\)/,
    "🔴 адреса будується не за видом цілі (компанія / контакт / угода)");

  // проводка екрана: блок у картці, нова вкладка, без тверджень про CRM
  const panel = readFileSync(FE("ClientCardPanel.tsx"), "utf8");
  assert.match(panel, /<ClientKommoBlock card=\{card\} \/>/, "🔴 картка клієнта не малює блок Kommo");
  const block = readFileSync(FE("ClientKommoBlock.tsx"), "utf8");
  assert.match(block, /if \(!k \|\| k\.links\.length === 0\) return null;/, "🔴 без посилань блок малює порожню рамку");
  assert.match(block, /target="_blank" rel="noreferrer"/, "🔴 посилання відкривається в тій самій вкладці й зносить дашборд");
  assert.match(block, /k\.more > 0/, "🔴 «ще N» на екрані не показано");
  const shown = block.slice(block.indexOf("export function ClientKommoBlock"));
  assert.doesNotMatch(shown, /не прикріплен|немає компанії/i, "🔴 екран стверджує про CRM те, чого база не знає (горизонт бекфілу)");
});
