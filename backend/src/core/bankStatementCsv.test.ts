import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  privatCsvText, privatAmount, encodeCp1251, monoCsvText, monoAmount, monoTime, excludeHidden,
  statementFile, PRIVAT_HEADER, MONO_HEADER,
} from "./bankStatementCsv.js";

const P = (o: Record<string, unknown>) => ({
  AUT_MY_CRF: "3478512294", AUT_MY_MFO: "305299", AUT_MY_ACC: "UA70", CCY: "UAH", AUT_CNTR_MFO: "300119",
  AUT_CNTR_MFO_NAME: 'АТ "БАНК АЛЬЯНС"', AUT_CNTR_ACC: "UA23", AUT_CNTR_CRF: "3714400593", ...o,
});

/**
 * #598 — ФОРМАТ ПРИВАТ24, як його зняв замір 21.09.2026 (178 рядків зі 178): 13 колонок у
 * порядку банку, хвостовий `;`, LF, списання з мінусом і пробілом у тисячах, латинські `i`/`I`
 * на місці українських, порядок «час спадно → ідентифікатор спадно», лапки НЕ екрануються.
 * Червоніє на зміні роздільника, знака, заміни літер, порядку колонок чи сортування.
 */
test("#598 ВИПИСКА ПРИВАТ: рядок байт-у-байт як у банку — колонки, `;` в кінці, мінус, тисячі, латинська i, порядок", () => {
  const rows = [
    P({ ID: "100", NUM_DOC: "11", DAT_OD: "01.08.2026", DATE_TIME_DAT_OD_TIM_P: "01.08.2026 09:00:00", AUT_CNTR_NAM: "Добитін Богдан", SUM: "300.00", TRANTYPE: "C", OSND: "Оплата за послугу" }),
    P({ ID: "205", NUM_DOC: "@2PL1", DAT_OD: "31.08.2026", DATE_TIME_DAT_OD_TIM_P: "31.08.2026 10:00:00", AUT_CNTR_NAM: "ІВАНОВ І. І.", SUM: "70000", TRANTYPE: "D", OSND: "Переказ; власних, коштів" }),
    P({ ID: "206", NUM_DOC: "@2PL2", DAT_OD: "31.08.2026", DATE_TIME_DAT_OD_TIM_P: "31.08.2026 10:00:00", AUT_CNTR_NAM: "Марія", SUM: "1234.5", TRANTYPE: "C", OSND: "За послугу" }),
  ];
  const lines = privatCsvText(rows).split("\n");
  assert.equal(lines[0], "ЄДРПОУ;МФО;Рахунок;Валюта;Номер документу;Дата операції;МФО банку;Назва банку;Рахунок кореспондента;ЄДРПОУ кореспондента;Кореспондент;Сума;Призначення платежу;");
  assert.equal(PRIVAT_HEADER.length, 13);
  // однаковий час → більший ID вище; найстаріша операція внизу
  assert.equal(lines[1], '3478512294;305299;UA70;UAH;@2PL2;31.08.2026;300119;АТ "БАНК АЛЬЯНС";UA23;3714400593;Марiя;1 234.50;За послугу;');
  assert.equal(lines[2], '3478512294;305299;UA70;UAH;@2PL1;31.08.2026;300119;АТ "БАНК АЛЬЯНС";UA23;3714400593;IВАНОВ I. I.;-70 000.00;Переказ; власних, коштiв;');
  assert.equal(lines[3], '3478512294;305299;UA70;UAH;11;01.08.2026;300119;АТ "БАНК АЛЬЯНС";UA23;3714400593;Добитiн Богдан;300.00;Оплата за послугу;');
  assert.equal(lines[4], "", "файл закінчується переносом рядка");
  assert.equal(lines.length, 5);
  assert.equal(privatAmount("1500000.4", false), "1 500 000.40");
  assert.equal(privatAmount("999", true), "-999.00", "🪞 без тисяч пробілу немає");
});

/**
 * #598b — БАЙТИ: Windows-1251 і LF, не UTF-8 і не CRLF; символ поза кодуванням стає `?` і
 * РАХУЄТЬСЯ. Червоніє, якщо віддати UTF-8 (кирилиця стане двобайтною) або загубити лічильник.
 */
test("#598b ВИПИСКА ПРИВАТ: байти Windows-1251 з LF; символ поза кодуванням названо числом", () => {
  const { bytes, lost } = encodeCp1251("Єдрпоу ї\n");
  assert.deepEqual([...bytes], [0xaa, 0xe4, 0xf0, 0xef, 0xee, 0xf3, 0x20, 0xbf, 0x0a]);
  assert.equal(lost, 0);
  const bad = encodeCp1251("ok 😀");
  assert.equal(bad.lost, 1); assert.equal(bad.bytes[3], 0x3f);
  const f = statementFile("privat", [P({ ID: "1", DAT_OD: "01.08.2026", SUM: "1", TRANTYPE: "C", AUT_CNTR_NAM: "А", OSND: "Б" })]);
  assert.equal(f.charset, "windows-1251");
  assert.ok(!Buffer.from(f.body).includes(0x0d), "CRLF у файлі");
  assert.equal(new TextDecoder("windows-1251").decode(f.body).split("\n")[0].slice(0, 6), "ЄДРПОУ", "🪞 декодується назад у заголовок");
});

/**
 * #598c — ФОРМАТ МОНО за зразком виписки: UTF-8, кома, в лапках лише поля з пробілом, порожнє
 * `—`, суми з щонайменше однією цифрою після крапки, час за Києвом, новіші зверху.
 * Червоніє на зміні правила лапок, формату суми, поясу чи порядку.
 */
test("#598c ВИПИСКА МОНО: заголовок і рядки як у зразку — лапки лише де пробіл, `—`, `2000.0`, київський час", () => {
  const rows = [
    { time: 1782283817, description: "Від: Prokopenko Yevhenii", mcc: 6012, amount: 200000, operationAmount: 200000, currencyCode: 980, commissionRate: 0, cashbackAmount: 0, balance: 305131 },
    { time: 1782805506, description: "Railway", mcc: 5734, amount: -22515, operationAmount: -22515, currencyCode: 980, commissionRate: 0, cashbackAmount: 0, balance: 31 },
  ];
  const lines = monoCsvText(rows).split("\n");
  assert.equal(lines[0], '"Дата i час операції","Деталі операції",MCC,"Сума в валюті картки (UAH)","Сума в валюті операції",Валюта,Курс,"Сума комісій (UAH)","Сума кешбеку (UAH)","Залишок після операції"');
  assert.equal(MONO_HEADER.length, 10);
  assert.equal(lines[1], '"30.06.2026 10:45:06",Railway,5734,-225.15,-225.15,UAH,—,—,—,0.31');
  assert.equal(lines[2], '"24.06.2026 09:50:17","Від: Prokopenko Yevhenii",6012,2000.0,2000.0,UAH,—,—,—,3051.31');
  assert.equal(monoAmount(-305100), "-3051.0"); assert.equal(monoAmount("x"), "—");
  assert.equal(monoTime(1782805506), "30.06.2026 10:45:06");
  assert.equal(statementFile("mono", rows).charset, "utf-8");
});

/**
 * #598d — МЕЖА ПРИХОВАНИХ І ПРАВО: без `view_hidden_payments` вихідний платіж прихованому
 * отримувачу у файл НЕ потрапляє і РАХУЄТЬСЯ; вхідний від того самого імені лишається;
 * 🪞 роль із правом отримує все. Роут стоїть за `export_bank_statement` і віддає лічильник
 * заголовком. Червоніє, якщо прибрати фільтр, загубити лічильник або зняти право з роута.
 */
test("#598d ВИПИСКА: приховані виключено й пораховано, з правом — усе; роут за правом export_bank_statement", () => {
  const rows = [
    { direction: "out", counterparty_name: "СЕКРЕТ" }, { direction: "in", counterparty_name: "СЕКРЕТ" },
    { direction: "out", counterparty_name: "Звичайний" },
  ];
  const hid = (n: string | null) => n === "СЕКРЕТ";
  const a = excludeHidden(rows, hid, false);
  assert.equal(a.visible.length, 2); assert.equal(a.hiddenExcluded, 1);
  assert.ok(a.visible.some((x) => x.direction === "in" && x.counterparty_name === "СЕКРЕТ"), "вхідні не ховаються");
  const b = excludeHidden(rows, hid, true);
  assert.equal(b.visible.length, 3); assert.equal(b.hiddenExcluded, 0);

  const src = path.join(import.meta.dirname, "..", "..", "src");
  const route = readFileSync(path.join(src, "routes", "bank.ts"), "utf8");
  assert.match(route, /bankRouter\.get\("\/statement\.csv", requirePerm\("export_bank_statement"\)/, "роут без права");
  const i = route.indexOf('bankRouter.get("/statement.csv"'); const body = route.slice(i, route.indexOf("\n});", i));
  assert.match(body, /roleHasPerm\(req\.auth!\.roleKey, "view_hidden_payments"\)/);
  assert.match(body, /"X-Hidden-Excluded"/, "неповний файл не називає своєї неповноти");
  const data = readFileSync(path.join(src, "core", "bankStatement.ts"), "utf8");
  assert.match(data, /\bexcludeHidden\(r\.rows,/, "вибірка не проходить через межу прихованих");
  const schema = readFileSync(path.join(src, "db", "schema.sql"), "utf8");
  assert.match(schema, /"export_bank_statement": true\}'::jsonb\s+WHERE key IN \('admin', 'ceo', 'opdir', 'financier', '____________'\)/);
  assert.match(readFileSync(path.join(src, "auth", "permGrant.ts"), "utf8"), /"export_bank_statement",/);
});
