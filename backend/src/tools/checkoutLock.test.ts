import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TTL_MIN, viewLock, decide, lossFor, cli, readEvents, claimPath, claimFresh,
  type Claim, type LockEvent,
} from "./checkoutLock.js";

/**
 * 🔒 #227–#227f — ЗАМОК ПРОД-ЧЕКАУТУ.
 *
 * Гейти без БД, без мережі, без прода: працюють на власному тимчасовому каталозі,
 * тож червоніють у будь-який день тижня і в будь-якому оточенні (урок #220-#221b).
 */
const scratch = () => mkdtempSync(path.join(tmpdir(), "lock-"));
const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const claim = (who: string, min: number, reason = "викат"): Claim => ({ who, at: at(min), reason });

test("#227 ЗАЙНЯТИЙ ЗАМОК ВІДМОВЛЯЄ Й НАЗИВАЄ ТРИМАЧА, ЧАС І СПРАВУ", () => {
  // Замок існує заради ОДНОГО питання: «хто там і що робить». Відмова без імені
  // перетворює його на перешкоду, яку обходять руками.
  const v = decide("take", viewLock(claim("Основний", 3, "викат стека v6"), new Date()), "HR", "замок", false);
  assert.equal(v.ok, false);
  if (v.ok) return;
  const txt = v.lines.join("\n");
  assert.match(txt, /Основний/, "🔴 не названо тримача");
  assert.match(txt, /3 хв/, "🔴 не названо, скільки він там");
  assert.match(txt, /викат стека v6/, "🔴 не названо, що саме робиться");
  assert.notEqual(v.code, 0, "🔴 відмова з нульовим кодом — скрипт поїде далі");
  // Дзеркало: вільний замок мусить БРАТИСЬ, інакше гейт зеленів би на завжди-зайнятому.
  const free = decide("take", viewLock(null, new Date()), "HR", "замок", false);
  assert.equal(free.ok, true, "🔴 вільний замок не береться — механізм мертвий");
});

test("#227b TTL НЕ ЗВІЛЬНЯЄ САМ: прострочений замок лишається ЗАЙНЯТИМ", () => {
  // 🔴 Автозвільнення за таймером — це та сама крадіжка, тільки без імені й без
  // причини: замок зникає, а в журналі порожньо.
  const old = viewLock(claim("Допоміжний", TTL_MIN + 5), new Date());
  assert.equal(old.expired, true, "🔴 протермінування не помічено");
  assert.equal(old.held, true, "🔴 прострочений замок вважається ВІЛЬНИМ — це автозвільнення й є");
  const v = decide("take", old, "HR", "замок", false);
  assert.equal(v.ok, false, "🔴 замок віддано мовчки, без явної дії");
  if (v.ok) return;
  assert.match(v.lines.join("\n"), /TTL .* ВИЙШОВ/, "🔴 причина відмови не пояснює, що TTL вийшов, а замок усе одно чужий");
  assert.match(v.lines.join("\n"), /--after-ttl/, "🔴 не сказано, ЯК перехопити явно — тоді перехоплять руками");
  // І межа з іншого боку: свіжий замок не сміє вважатись простроченим.
  assert.equal(viewLock(claim("X", TTL_MIN - 1), new Date()).expired, false,
    "🔴 замок протермінувався раніше за TTL — люди почнуть перехоплювати живі");
});

test("#227c ПЕРЕХОПЛЕННЯ ПІСЛЯ TTL пише подію з причиною, яку склав НЕ перехоплювач", () => {
  const v = decide("take", viewLock(claim("Основний", TTL_MIN + 7, "верстка v6"), new Date()), "HR", "", true);
  assert.equal(v.ok, true, "🔴 явне перехоплення не працює — TTL став вічним замком");
  if (!v.ok) return;
  assert.equal(v.kind, "take-after-ttl", "🔴 перехоплення записується як звичайне взяття — слід губиться");
  assert.match(v.note, /Основний/, "🔴 подія не називає, В КОГО перехоплено");
  assert.match(v.note, /\d+ хв/, "🔴 подія не називає вік замка — читач не відрізнить перехоплення від взяття вільного");
  assert.match(v.note, /верстка v6/, "🔴 подія не зберігає, що робив попередник");
});

test("#227d --steal ВИМАГАЄ ПРИЧИНУ, і слід видно ПОТІМ у журналі", () => {
  const repo = scratch();
  // Без причини — відмова: слід без «чому» за тиждень нічого не пояснює.
  assert.equal(cli(["--steal", "--who=HR"], repo).code, 2, "🔴 крадіжка без причини дозволена");
  // Беремо, потім відбираємо іншим імʼям.
  assert.equal(cli(["--take", "--who=Основний", "--reason=викат v6"], repo).code, 0);
  assert.equal(cli(["--steal", "--who=HR", "--reason=прод лежить, потрібен відкат"], repo).code, 0);
  const ev = readEvents(repo);
  assert.equal(ev.at(-1)!.kind, "steal", "🔴 у журналі немає події крадіжки");
  assert.equal(ev.at(-1)!.lostBy, "Основний", "🔴 не записано, В КОГО відібрано");
  assert.match(ev.at(-1)!.reason, /прод лежить/, "🔴 причину не збережено — слід є, сенсу немає");
  // 🔴 І головне: слід ПЕРЕЖИВАЄ звільнення. Претензія зникає, історія — ні.
  assert.equal(cli(["--release", "--who=HR"], repo).code, 0);
  assert.equal(existsSync(claimPath(repo)), false, "🔴 претензія лишилась після звільнення");
  assert.equal(readEvents(repo).filter((e) => e.kind === "steal").length, 1,
    "🔴 звільнення стерло історію крадіжки — тоді її ніхто вже не побачить");
});

test("#227e ВТРАТУ ЗАМКА ВИДНО КОЛИШНЬОМУ ТРИМАЧЕВІ — ОБОМА ШЛЯХАМИ", () => {
  // Шляхів утратити замок два, і обидва мусять бути видимі тому, в кого забрали.
  // Один із них перевірити «заодно» не можна: вони пишуть різні події.
  const stolen: LockEvent[] = [
    { kind: "take", who: "HR", at: at(40), reason: "парсер" },
    { kind: "steal", who: "Основний", at: at(5), reason: "аварія", lostBy: "HR" },
  ];
  const ttl: LockEvent[] = [
    { kind: "take", who: "HR", at: at(60), reason: "парсер" },
    { kind: "take-after-ttl", who: "Допоміжний", at: at(5), reason: "перехоплено після TTL", lostBy: "HR" },
  ];
  for (const [label, ev] of [["крадіжка", stolen], ["перехоплення після TTL", ttl]] as const) {
    const l = lossFor("HR", ev);
    assert.ok(l, `🔴 ${label}: колишній тримач НЕ бачить, що замка в нього немає — він піде працювати в чужий чекаут`);
    assert.ok(l!.who !== "HR", `🔴 ${label}: не названо, хто забрав`);
  }
  // Дзеркало: поки замок мій, «втрати» бути не може, інакше попередження стане шумом.
  assert.equal(lossFor("HR", [{ kind: "take", who: "HR", at: at(2), reason: "р" }]), null,
    "🔴 живий замок показано як втрачений");
  // І другий бік: після втрати я взяв заново — попередження мусить ЗНИКНУТИ.
  assert.equal(lossFor("HR", [...stolen, { kind: "take", who: "HR", at: at(1), reason: "знову" }]), null,
    "🔴 попередження про втрату не гасне після повторного взяття — його навчаться ігнорувати");
});

test("#227f ЗВІЛЬНЕННЯ НЕ-ТРИМАЧЕМ НАЗИВАЄ ВТРАТУ, а не мовчазний «успіх»", () => {
  // 🔴 Найгірший вихід тут — нуль і слово «звільнено»: людина піде працювати,
  // впевнена, що замок її, тоді як він чужий.
  const v = decide("release", viewLock(claim("Основний", 4, "верстка"), new Date()), "HR", "", false);
  assert.equal(v.ok, false, "🔴 не-тримач «звільнив» чужий замок");
  if (v.ok) return;
  assert.notEqual(v.code, 0, "🔴 мовчазний успіх кодом виходу");
  assert.match(v.lines.join("\n"), /Основний/, "🔴 не сказано, чий насправді замок");
  assert.match(v.lines.join("\n"), /--status/, "🔴 не сказано, де подивитись, коли саме він став чужим");
  // Дзеркало: свій замок звільняється, інакше «не-тримач» = «ніхто».
  const mine = decide("release", viewLock(claim("HR", 4), new Date()), "HR", "готово", false);
  assert.equal(mine.ok, true, "🔴 тримач не може звільнити власний замок");
});

test("#227g ВЗЯТТЯ — ОДНА ОПЕРАЦІЯ ЯДРА (`wx`), а не «перевірив і записав»", () => {
  // Між `existsSync` і `writeFileSync` вміщується чужий процес. `wx` цієї щілини
  // не має за побудовою: перевірка й створення — один системний виклик.
  const repo = scratch();
  assert.equal(claimFresh(repo, claim("A", 0)), true, "🔴 перше взяття не спрацювало");
  assert.equal(claimFresh(repo, claim("B", 0)), false,
    "🔴 ДРУГЕ взяття теж «успішне» — замок не тримає нічого; перевір, чи не зник прапорець wx");
  assert.equal((JSON.parse(readFileSync(claimPath(repo), "utf8")) as Claim).who, "A",
    "🔴 другий перезаписав претензію першого");
  // Пошкоджений файл замка вважається ЗАЙНЯТИМ, а не вільним: невідоме не сміє
  // читатись як «нікого немає» (той самий урок, що з порожнім результатом).
  writeFileSync(claimPath(repo), "{зіпсовано");
  assert.equal(cli(["--take", "--who=C", "--reason=r"], repo).code !== 0, true,
    "🔴 пошкоджений замок прочитано як вільний");
});
