import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 🎞 Презентація щотижневої зустрічі: модель слайдів і PPTX (04.11.2026). Обидва файли фронта чисті (лише `import type`),
 * тож гейт їх транспілює й ВИКОНУЄ — перевіряється поведінка, а не текст джерела.
 */
const FE = (f: string) => fileURLToPath(new URL(`../../../frontend/src/pages/dashboard/${f}`, import.meta.url).href.replace("/backend/dist/", "/backend/src/"));
const TEMPLATE = fileURLToPath(new URL("../../assets/presentation-template.pptx", import.meta.url));
async function load(f: string) {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE(f), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}

const NAMES: Record<string, string> = { 1: "Перший Менеджер", 2: "Другий Менеджер", 3: "Третій Менеджер", 4: "Четвертий Менеджер", 5: "Пʼятий Менеджер", 7: "Новачок Адаптаційний", 8: "Досвідчений Прориву" };
const top = (places: number[], vals: number[]) => places.map((place, i) => ({ place, managerId: i + 1, value: vals[i], manual: false }));
const conv = (n: number) => Array.from({ length: n }, (_, i) => ({ managerId: i + 1, name: NAMES[i + 1] ?? `Менеджер ${i + 1}`, taken: 30 - i, won: 9 - i, pct: 30 - i * 3, prevPct: [20, 40, 24, null, 10, 10][i] ?? null, onSlide: true }));
function fixture(o: { adapting?: number[]; leadgen?: boolean; rnk?: number; tops?: boolean } = {}) {
  const week = {
    weekFrom: "2026-10-26", weekTo: "2026-11-01", state: "frozen", freezeDueAt: "2026-11-03T15:00:00+02:00", names: NAMES,
    companyTop: o.tops === false ? {} : {
      maxDeal: top([1, 2, 3, 3, 3], [62980, 37238, 24560, 24560, 24560]),
      revenue: top([1, 1, 2], [500000, 500000, 1]),
      cars: top([1], [31]),
      intl: [],
    },
    rnkConv: o.rnk ? { rows: conv(o.rnk), comment: { text: "Висновок тижня від керівника" } } : null,
    leadgen: o.leadgen === false ? null : {
      members: [{ id: 5, name: "Пʼятий Менеджер" }],
      cells: [{ nomination: "lgQuotes", final: { status: "auto", winners: [5], value: 34 } }, { nomination: "lgMaxDeal", final: { status: "empty", winners: [], value: null } }],
    },
    texts: { focus: { text: "10 нових клієнтів" } },
    photos: {},
  };
  const plan = (fact: number, plan: number) => ({ glance: { fact, plan, expectThisMonth: 548084 }, managers: [] });
  const weekRep = { glance: {}, managers: [
    { managerId: 7, name: "Новачок Адаптаційний", plan: 1000, pct: 2664 },
    { managerId: 8, name: "Досвідчений Прориву", plan: 50000, pct: 615 },
    { managerId: 9, name: "Без Плану", plan: 0, pct: 9999 },
  ] };
  const extras = {
    birthdays: [{ employeeId: 11, name: "Іменинник Перший Батькович", date: "2026-10-27" }],
    newcomers: [{ employeeId: 12, name: "Новенька Перша", day: "2026-10-28", managerId: 7, cars: 5 }, { employeeId: 13, name: "Новенька Друга", day: "2026-10-29", managerId: null, cars: null }],
    newPositions: [], rookies: [{ employeeId: 12, name: "Новенька Перша", managerId: 7, hiredAt: "2026-10-14", cars: 8 }],
    newClients: { rows: [{ managerId: 3, first: 4 }, { managerId: 4, first: 4 }], unknown: 0 },
    adaptingManagerIds: o.adapting ?? [7], employees: [], photos: {},
  };
  return { week, month: plan(218905, 3450748), weekRep, extras, today: "2026-11-04" };
}

/**
 * #3468 — МОДЕЛЬ СЛАЙДІВ: одна на екран і на PPTX (04.11.2026). Топ — три рядки, хто ділить місце з третім — у підпис
 * (не зникає мовчки); «Прорив» без людей на адаптації (ревʼю: 2664% у новачка) і без нульового плану; нічия у відзнаці —
 * усі імена; тренд конверсії у п.п. з напрямком; пульс — від `glance` Звіту.
 * 🧨 Червоніє, якщо показати 4-те місце рядком, загубити нічию з третім, пустити новачка в «Прорив» чи зламати тренд.
 */
test("#3468 модель слайдів: топ — 3 рядки й нічия з третім підписом, «Прорив» без адаптації, нічия у відзнаці, тренд у п.п.", async () => {
  const { buildPresentationModel } = await load("presentationModel.ts");
  const m = buildPresentationModel(fixture({ rnk: 6 }));
  assert.deepEqual(m.tops.maxDeal.rows.map((r: { place: number }) => r.place), [1, 2, 3], "🔴 у топі не рівно три рядки");
  assert.deepEqual(m.tops.maxDeal.tied, ["Четвертий Менеджер", "Пʼятий Менеджер"], "🔴 хто ділить третє місце — загублений");
  assert.deepEqual(m.tops.revenue.tied, [], "🔴 підпис нічиї там, де ніхто не ділить третє");
  assert.equal(m.tops.maxDeal.rows[0].text, "62 980 ₴", "🔴 сума в топі не у форматі слайда");
  assert.equal(m.tops.cars.rows[0].text, "31 авто");
  assert.deepEqual(m.tops.intl.rows, [], "🔴 порожня номінація дала рядки");
  assert.deepEqual(m.awards.proryv.names, ["Досвідчений Прориву"], "🔴 «Прорив» узяв людину на адаптації або без плану");
  assert.equal(m.awards.proryv.value, "615% плану");
  // дзеркало: без адаптації той самий новачок — переможець (тобто відсікає саме адаптація, а не щось інше)
  assert.deepEqual(buildPresentationModel(fixture({ adapting: [], rnk: 6 })).awards.proryv.names, ["Новачок Адаптаційний"], "🔴 «Прорив» відсікає новачка не через адаптацію");
  assert.deepEqual(m.awards.clients.names, ["Третій Менеджер", "Четвертий Менеджер"], "🔴 нічия у «Новому клієнті» — не всі імена");
  assert.equal(m.awards.rookie.employeeId, 12, "🔴 «Новачок тижня» без співробітника для фото");
  assert.deepEqual(m.conv.rows.map((r: { trend: string }) => r.trend), ["▲ 10 п.п.", "▼ 13 п.п.", "=", "—", "▲ 8 п.п.", "▲ 5 п.п."], "🔴 тренд конверсії зламано");
  assert.equal(m.pulse.pct, 6); assert.equal(m.pulse.left, 3450748 - 218905);
  assert.equal(m.events.map((e: { kind: string }) => e.kind).join(","), "birthday,newcomer,newcomer", "🔴 події тижня не в порядку ДР → новачки → посади");
  assert.equal(m.events[1].text, "Уже 5 поставлених авто на адаптації");
  assert.equal(m.meeting, "2026-11-03");
});

/**
 * #3469 — PPTX ЗА ШАБЛОНОМ ДАШІ (04.11.2026, «щоб можна було редагувати»). Шаблон лежить там, звідки його віддає роут;
 * заповнений файл — справжній zip, у слайдах імена й суми тижня, фото лягли в коло, тип JPEG зареєстровано; слайд без
 * даних ВИКИНУТО (у шаблоні на ньому приклад Даші з чужими іменами); ЖОДЕН приклад шаблону не доживає до файлу.
 * 🧨 Червоніє, якщо лишити приклад («Крицька Діана», «27.10.2026») на будь-якому слайді, загубити рядки лідерборду за
 * межами 4-х, не викинути порожній слайд, не зареєструвати JPEG чи не перевести фото в коло.
 */
test("#3469 PPTX: шаблон на місці, імена й суми тижня в слайдах, фото в колі, порожній слайд викинуто, прикладів шаблону немає", async () => {
  assert.ok(existsSync(TEMPLATE), "🔴 шаблону PPTX немає там, звідки його віддає роут /pptx-template");
  const { buildPresentationModel } = await load("presentationModel.ts");
  const P = await load("pptxTemplate.ts");
  const dec = new TextDecoder();
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const build = async (fx: ReturnType<typeof fixture>) => {
    const m = buildPresentationModel(fx);
    const photos = new Map(P.photoNeeds(m).map((n: { slot: string }) => [n.slot, jpg]));
    const bytes: Uint8Array = P.zipStore(P.fillPptx(await P.unzip(new Uint8Array(readFileSync(TEMPLATE))), m, photos));
    assert.equal(dec.decode(bytes.subarray(0, 2)), "PK", "🔴 результат — не zip");
    return P.unzip(bytes) as Promise<Map<string, Uint8Array>>;
  };
  const text = (f: Map<string, Uint8Array>, n: number) => P.runsOf(dec.decode(f.get(`ppt/slides/slide${n}.xml`)!)).join(" | ") as string;

  const f = await build(fixture({ rnk: 6 }));
  const all = [...f.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).map((k) => dec.decode(f.get(k)!)).join("\n");
  for (const sample of ["Крицька Діана", "Куйбіда Сергій", "Самохвалов Сергій", "Сердюк Ярослав", "Цалко Олександр", "Юрко Дмитро", "27.10.2026", "[Ім’я Прізвище]", "[__"])
    assert.ok(!all.includes(sample), `🔴 у файлі лишився приклад шаблону: «${sample}»`);
  assert.match(text(f, 4), /Перший Менеджер \| 62 980 ₴/, "🔴 переможця й суму тижня немає в слайді «Гроші тижня»");
  assert.match(text(f, 4), /з тим самим результатом: Четвертий Менеджер, Пʼятий Менеджер/, "🔴 нічия з третім загублена у файлі");
  assert.match(text(f, 6), /Досвідчений Прориву \| 615% плану/, "🔴 «Прорив» не той, що на екрані");
  assert.match(text(f, 8), /далі: 5\. Пʼятий Менеджер 18%, 6\. Менеджер 6 15%/, "🔴 рядки лідерборду за межами 4-х зникли мовчки");
  assert.match(text(f, 1), /03\.11\.2026/, "🔴 дата зустрічі не в титулі");
  assert.ok(!text(f, 1).includes("Фото команди"), "🔴 підпис-заглушка лежить поверх фото команди");
  const s4 = dec.decode(f.get("ppt/slides/slide4.xml")!), r4 = dec.decode(f.get("ppt/slides/_rels/slide4.xml.rels")!);
  assert.match(r4, /Id="rId2"[^>]*Target="\.\.\/media\/pres-4-rId2\.jpg"|Target="\.\.\/media\/pres-4-rId2\.jpg"[^>]*Id="rId2"/, "🔴 фото не привʼязане до слоту");
  assert.ok(f.has("ppt/media/pres-4-rId2.jpg"), "🔴 файлу фото немає в архіві");
  assert.match(/<p:pic>(?:(?!<\/p:pic>)[\s\S])*r:embed="rId2"[\s\S]*?<\/p:pic>/.exec(s4)?.[0] ?? "", /prst="ellipse"/, "🔴 фото не переведено в коло");
  assert.match(dec.decode(f.get("[Content_Types].xml")!), /Extension="jpg"/, "🔴 тип JPEG не зареєстровано — PowerPoint не відкриє файл");

  // Слайди без даних — геть, як на екрані: лідогенерації й лідерборду немає → у файлі 7 слайдів і жодного прикладу.
  const g = await build(fixture({ leadgen: false, rnk: 0 }));
  const pres = dec.decode(g.get("ppt/presentation.xml")!);
  assert.equal((pres.match(/<p:sldId /g) ?? []).length, 7, "🔴 порожні слайди не викинуто зі списку презентації");
  assert.ok(!g.has("ppt/slides/slide7.xml") && !g.has("ppt/slides/slide8.xml"), "🔴 файли порожніх слайдів лишились");
  assert.ok(!dec.decode(g.get("[Content_Types].xml")!).includes("slide7.xml"), "🔴 тип вмісту викинутого слайда лишився");
  // дзеркало: слайд із даними НЕ викидається
  assert.equal((dec.decode(f.get("ppt/presentation.xml")!).match(/<p:sldId /g) ?? []).length, 9, "🔴 викинуто слайд, на якому є дані");
});

/**
 * #3471 — ЗВУК ПРЕЗЕНТАЦІЇ (09.11.2026). Музика Даші — лише на титулі, поки збираються (і лише коли трек є); фанфари — на
 * вході на слайд з номінантами, ОДИН раз за показ; «Події тижня», «Пульс» і «Фокус» — без фанфар; 🔇 глушить усе.
 * 🧨 Червоніє, якщо музика заграє на іншому слайді, фанфари — на «Пульсі», не заграють на «Грошах тижня», повторяться при
 * поверненні на слайд або прорвуться крізь 🔇.
 */
test("#3471 звук презентації: музика лише на титулі, фанфари на слайдах з номінантами раз за показ, 🔇 глушить усе", async () => {
  const { soundFor, FANFARE_SLIDES } = await load("presentationSound.ts");
  const none = new Set<string>();
  const on = (key: string, o: { muted?: boolean; hasMusic?: boolean; played?: Set<string> } = {}) =>
    soundFor(key, { muted: o.muted ?? false, hasMusic: o.hasMusic ?? true, played: o.played ?? none });
  assert.deepEqual(on("title"), { music: true, fanfare: false }, "🔴 на титулі не грає музика або грають фанфари");
  assert.deepEqual(on("title", { hasMusic: false }), { music: false, fanfare: false }, "🔴 музика «грає» без треку");
  for (const k of ["events", "pulse", "focus"]) assert.deepEqual(on(k), { music: false, fanfare: false }, `🔴 на слайді «${k}» звук, якого там бути не має`);
  for (const k of ["money", "volume", "awards", "leadgen", "conv"]) {
    assert.deepEqual(on(k), { music: false, fanfare: true }, `🔴 на слайді з номінантами «${k}» немає фанфар (або грає музика)`);
    assert.equal(on(k, { played: new Set([k]) }).fanfare, false, `🔴 фанфари на «${k}» повторились при поверненні`);
  }
  assert.equal(on("volume", { played: new Set(["money"]) }).fanfare, true, "🔴 фанфари одного слайда заглушили інший");
  for (const k of ["title", "money", "conv"]) assert.deepEqual(on(k, { muted: true }), { music: false, fanfare: false }, `🔴 звук прорвався крізь 🔇 на «${k}»`);
  // Перелік слайдів з фанфарами — ключі, що справді існують у презентації (інакше фанфари мовчки не заграли б ніде).
  const src = readFileSync(FE("sections/NominationsPresentation.tsx"), "utf8");
  for (const k of FANFARE_SLIDES) assert.match(src, new RegExp(`key: "${k}"`), `🔴 слайда «${k}» у презентації немає — фанфари на ньому не заграють`);
});
