import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * ГЕЙТИ ЕКРАНІВ КЛІЄНТІВ — те, що не видно з ядра, бо живе в роуті:
 *   #30  живий пошук клієнта (форми обʼєднання/передачі);
 *   #30c ієрархія «команда → менеджер → клієнти» — ПОДАЧА, не скоуп.
 *
 * Питання, на яке вони відповідають: чи можна тепер знайти клієнта, не знаючи
 * канонічного ключа напамʼять, і чи не загубився хтось, коли список згорнули в
 * дерево. Обидва — проти ЖИВОГО API: SQL пошуку в ядрі не живе, тож перевірити
 * його «з боку функції» неможливо.
 */
const load = async () => ({
  signToken: (await import("../auth/auth.js")).signToken,
  rbac: await import("../auth/rbac.js"),
});

async function adminToken(): Promise<string> {
  const { signToken, rbac } = await load();
  await rbac.refreshRoles();
  // Роль-скоуп беремо ТИМ САМИМ резолвером, що й решта тестів (`scopeCompatRole`),
  // а не зашитим рядком: інакше тест перевіряв би свою уяву про адміна.
  return signToken({ userId: 0, role: rbac.scopeCompatRole("admin", rbac.getRoleDef("admin")),
                     roleKey: "admin", managerId: null, teamId: null });
}
const get = async (path: string, token: string) =>
  fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });

test("#30 ПОШУК КЛІЄНТА: знаходить за НАЗВОЮ і за КЛЮЧЕМ — і це та сама людина", needsApi(), async () => {
  const token = await adminToken();
  // Шукаємо за шматком НАЗВИ, як шукала б людина: канонічний ключ («вкавтострада»)
  // з екрана дізнатись було нізвідки — саме через це формою не могли скористатись.
  const byName = await (await get("/api/dashboard/client-search?q=" + encodeURIComponent("автострада"), token)).json();
  assert.ok(Array.isArray(byName) && byName.length > 0,
    "🔴 пошук за назвою нічого не знайшов — перевіряти НЕМА ЧОГО, це провал, а не успіх");
  const hit = byName[0];
  assert.ok(hit.clientKey && hit.clientName, "рядок пошуку без ключа або назви");
  assert.ok("managerName" in hit,
    "🔴 у видачі немає менеджера — саме він і був суттю правки «менеджер біля кожного клієнта»");

  // А тепер за самим КЛЮЧЕМ — має знайтись той самий клієнт.
  const byKey = await (await get("/api/dashboard/client-search?q=" + encodeURIComponent(hit.clientKey), token)).json();
  assert.ok(byKey.some((h: { clientKey: string }) => h.clientKey === hit.clientKey),
    `🔴 за власним ключем «${hit.clientKey}» клієнт не знаходиться — пошук працює лише в один бік`);
});

test("#30b ДЗЕРКАЛО: пошук НЕ віддає всіх підряд", needsApi(), async () => {
  // Без цієї пари #30 зеленів би й тоді, якби роут повертав перші 20 клієнтів на
  // будь-який запит: «знайшлось» виглядало б однаково.
  const token = await adminToken();
  const junk = await (await get("/api/dashboard/client-search?q=zzzqqq__nemaje_takogo__", token)).json();
  assert.deepEqual(junk, [], "🔴 на сміттєвий запит повернулись клієнти — фільтр не застосовується");
  // Один символ — теж порожньо: інакше кожне натискання клавіші тягнуло б повний скан.
  const tooShort = await (await get("/api/dashboard/client-search?q=а", token)).json();
  assert.deepEqual(tooShort, [], "🔴 запит з однієї літери щось повернув — поріг довжини не діє");
});

test("#30c ІЄРАРХІЯ — ЦЕ ПОДАЧА: жоден клієнт не зник і не роздвоївся", needsApi(), async () => {
  // 🔴 Групування живе у фронті, але ГРУПУВАТИ НЕМА ЧИМ, якщо бекенд не назвав
  // команду. Перевіряємо саме те, на чому стоїть дерево: команда є в КОЖНОГО
  // рядка, і сума по командах дорівнює сумі плоского списку — до гривні.
  const token = await adminToken();
  const res = await get("/api/dashboard/client-plans", token);
  assert.equal(res.status, 200, `client-plans віддав ${res.status}`);
  const data = await res.json() as {
    clients: { clientKey: string; teamName: string; managerId: number; fact: number; plan: number }[];
    totals: { factTotal: number; totalClients: number };
  };
  assert.ok(data.clients.length > 0, "🔴 клієнтів немає — інваріант нічого не доводить");

  const noTeam = data.clients.filter((c) => !c.teamName);
  assert.deepEqual(noTeam.map((c) => c.clientKey), [],
    "🔴 є рядки без назви команди — у дереві вони провалились би в порожній вузол");

  const byTeam = new Map<string, number>();
  const keys = new Set<string>();
  for (const c of data.clients) {
    byTeam.set(c.teamName, (byTeam.get(c.teamName) ?? 0) + c.fact);
    keys.add(c.clientKey);
  }
  assert.equal(keys.size, data.clients.length,
    "🔴 клієнт трапляється двічі — у дереві він потрапив би у дві гілки й подвоїв підсумок");
  const sumTeams = [...byTeam.values()].reduce((s, v) => s + v, 0);
  const sumFlat = data.clients.reduce((s, c) => s + c.fact, 0);
  assert.equal(Math.round(sumTeams), Math.round(sumFlat),
    `🔴 Σ по командах ${Math.round(sumTeams)} ≠ Σ плоского списку ${Math.round(sumFlat)}`);
  assert.equal(data.totals.totalClients, data.clients.length,
    "🔴 підсумок «клієнтів» розійшовся з кількістю рядків");
});

test("#30d КАРТКА КЛІЄНТА віддає 12 місяців і НАЗИВАЄ анкер", needsApi(), async () => {
  const token = await adminToken();
  const list = await (await get("/api/dashboard/client-plans", token)).json() as {
    clients: { clientKey: string; fact: number }[];
  };
  const target = [...list.clients].sort((a, b) => b.fact - a.fact)[0];
  assert.ok(target, "🔴 немає жодного клієнта — перевірка порожня");
  const card = await (await get("/api/dashboard/client-card?clientKey=" + encodeURIComponent(target.clientKey), token)).json() as {
    months: { month: string; revenue: number }[]; deals: unknown[]; anchorNote: string; monthsTotal: number;
  };
  assert.equal(card.months.length, 12, `🔴 у картці ${card.months.length} місяців замість 12`);
  // 🔴 Підпис якоря — не косметика: без нього стовпчики ① і список угод (журнал
  // сутностей) читались би як одна сума, і «чому не сходиться» стало б багом.
  assert.ok(/анкер/i.test(card.anchorNote), "🔴 картка не називає анкер — дві різні суми без підпису");
  assert.equal(Math.round(card.monthsTotal), Math.round(card.months.reduce((s, m) => s + m.revenue, 0)),
    "🔴 підсумок 12 міс. не дорівнює сумі стовпчиків");
});

test("#30e МЕЖА: без токена екрани клієнтів не віддають нічого", needsApi(), async () => {
  // Дзеркало до #30/#30d: «доступно КВП/ОД/адміну» має означати «не всьому
  // інтернету». Матриця #11 перевіряє ролі, цей рядок — відсутність ролі взагалі.
  for (const p of ["/api/dashboard/client-search?q=автострада", "/api/dashboard/client-card?clientKey=zzz"]) {
    const res = await fetch(`${API_BASE}${p}`);
    assert.ok(res.status === 401 || res.status === 403,
      `🔴 ${p} без токена віддав ${res.status}`);
  }
});
