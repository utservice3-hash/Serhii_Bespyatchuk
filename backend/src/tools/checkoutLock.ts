/**
 * 🔒 ЗАМОК ПРОД-ЧЕКАУТУ — СИГНАЛІЗАЦІЯ, А НЕ МʼЮТЕКС.
 *
 * 🔴 ЧОГО ВІН НЕ РОБИТЬ, І ЦЕ СКАЗАНО ПЕРШИМ. Він **не унеможливлює** зіткнення:
 * будь-хто може виконати `git merge` руками, не спитавши нікого. Він **робить
 * зіткнення видимим і дорогим** — щоб «я не знав, що там хтось є» перестало бути
 * правдою, а перехоплення лишало імʼя.
 *
 * 🔴 ЗАМОК БЕРЕТЬСЯ ЗА ДОТИК ДО ЧЕКАУТУ, А НЕ ЗА НАМІР ДЕПЛОЮ. Намір деплою — це
 * стан голови; дотик — те, що ламає чуже дерево. 26.08.2026 я зробив саме це: мій
 * `ff` не пройшов, а окремі виклики збірки й копії — пройшли, і в докрут поїхав
 * бандл чужого коміту.
 *
 * ⚙️ ДВА ФАЙЛИ, І ПОДІЛ НЕ КОСМЕТИЧНИЙ:
 *   `.deploy-lock`      — ПРЕТЕНЗІЯ. Її існування і є замок. Створюється прапорцем
 *                         `wx` (`open(O_CREAT|O_EXCL)`) — тобто атомарно на рівні ядра.
 *   `.deploy-lock.log`  — ЖУРНАЛ, append-only, НІКОЛИ не видаляється. Тому «хто тримав»
 *                         не поле, яке можна переписати, а історія, яку можна лише
 *                         дописати. Звільнення прибирає претензію й лишає слід.
 *
 * 📐 АТОМАРНІСТЬ ЗАМІРЯНА, А НЕ ПРИПУЩЕНА (24 паралельні процеси):
 *   `wx`        → 1 переможець, 23 × EEXIST
 *   `rename(2)` → 1 переможець, 23 × ENOENT
 * ⚠️ УМОВА, НАЗВАНА ПОРУЧ ІЗ ТВЕРДЖЕННЯМ: `rename` атомарний **у межах однієї ФС**.
 * Тимчасовий файл тому кладеться поруч із замком, а не в `/tmp`. Гейта на «чи це
 * справді одна ФС» немає навмисно — перевірити це чесно з JS не можна, а гейт, що
 * вдає перевірку, гірший за названу межу.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, renameSync } from "node:fs";

export const TTL_MIN = 20;

/**
 * `touchedAt` — мить ОСТАННЬОГО ДОТИКУ ланцюга до замка.
 *
 * 🔴 TTL МІРЯЄ БЕЗДІЯЛЬНІСТЬ, А НЕ ВІК (рішення власника 02.09.2026). Доти
 * прострочення рахувалось від `at`, тобто від ВЗЯТТЯ, — і це називало «покинутим»
 * замок, який активно працював: заміряно того дня, що один прохід `run` триває
 * ~18 хв (з них 16 хв самого лише прогріву) при TTL 20 хв, тож нормальне коло
 * впритул підходило до порогу. Уся плутанина з перехопленнями звідти.
 * Тепер 25 хв посеред живого прогону — не покинутий замок, а 184 хв без жодного
 * кроку — покинутий.
 *
 * ⚠️ ПОЛЕ НЕОБОВʼЯЗКОВЕ, і це навмисно: старі заявки на диску його не мають, тож
 * `touchedAt ?? at` дає РІВНО стару поведінку. Міграції не потрібно.
 */
export interface Claim { who: string; at: string; reason: string; touchedAt?: string }
export type EventKind = "take" | "take-after-ttl" | "steal" | "release";
export interface LockEvent extends Claim { kind: EventKind; lostBy?: string }

export interface LockView {
  held: boolean;
  claim: Claim | null;
  /** Вік від ВЗЯТТЯ — лише для показу людині («тримає 184 хв»). */
  ageMin: number;
  /** Скільки хвилин ланцюг НЕ торкався замка. Саме це й судить TTL. */
  idleMin: number;
  /** Прострочений ≠ вільний. Обчислюється НА ЧИТАННІ й сам нічого не звільняє. */
  expired: boolean;
}

export function viewLock(claim: Claim | null, now: Date): LockView {
  if (!claim) return { held: false, claim: null, ageMin: 0, idleMin: 0, expired: false };
  const ageMin = Math.floor((now.getTime() - new Date(claim.at).getTime()) / 60_000);
  // 🔴 Немає `touchedAt` (стара заявка) → рахуємо від взяття, тобто як було.
  const idleMin = Math.floor((now.getTime() - new Date(claim.touchedAt ?? claim.at).getTime()) / 60_000);
  return { held: true, claim, ageMin, idleMin, expired: idleMin >= TTL_MIN };
}

export type Verdict =
  | { ok: true; kind: EventKind | "touch"; note: string }
  | { ok: false; code: number; lines: string[] };

/**
 * ЧИСТЕ РІШЕННЯ — уся політика тут, і саботується вона входом, а не файловою системою.
 *
 * 🔴 TTL НЕ ЗВІЛЬНЯЄ САМ. Автозвільнення за таймером — це та сама крадіжка, тільки
 * без імені й без причини: замок зникає, а в журналі порожньо. Прострочений замок
 * лишається ЗАЙНЯТИМ, і забрати його можна лише ЯВНОЮ дією, яка лишає подію.
 */
export function decide(
  op: "take" | "release" | "steal" | "touch",
  view: LockView,
  me: string,
  reason: string,
  afterTtl: boolean,
): Verdict {
  /**
   * 🔴 ДОТИК — FAIL-CLOSED, І ЦЕ ДРУГА ПОЛОВИНА РІШЕННЯ ПРО TTL. Ланцюг торкається
   * замка на кожному кроці: доти, доки він працює, замок не старіє. І та сама дія
   * відповідає на питання «а він іще мій?» — якщо замок перехопили, крок ПАДАЄ, а не
   * їде далі мовчки під чужим замком. Тиха робота під чужим замком і є те, що
   * робить крадіжку невидимою.
   */
  if (op === "touch") {
    if (!view.held) return { ok: false, code: 6, lines: [
      "🔴 ДОТИК ДО ПОРОЖНЬОГО ЗАМКА: заявки немає — отже ланцюг працює без замка.",
      "   Це не дрібниця: далі йдуть кроки, що чіпають спільне дерево.",
    ] };
    const c = view.claim!;
    if (c.who !== me) return { ok: false, code: 7, lines: [
      `🔴 ЗАМОК УЖЕ НЕ ТВІЙ — його тримає ${c.who} з ${c.at} (${view.ageMin} хв).`,
      `   робить: ${c.reason}`,
      "   Ланцюг зупиняється: працювати під чужим замком не можна навіть «дочитавши крок».",
    ] };
    return { ok: true, kind: "touch", note: `дотик ${me}` };
  }

  if (op === "take") {
    if (!view.held) return { ok: true, kind: "take", note: "замок вільний" };
    const c = view.claim!;
    if (c.who === me) return { ok: false, code: 0, lines: [`ℹ замок уже твій (взято ${c.at}): ${c.reason}`] };
    const head = [
      `🔒 ЧЕКАУТ ЗАЙНЯТО: ${c.who}, ${view.ageMin} хв тому (${c.at})`,
      `   робить: ${c.reason}`,
    ];
    if (!view.expired) {
      return { ok: false, code: 4, lines: [...head,
        `   TTL ${TTL_MIN} хв БЕЗДІЯЛЬНОСТІ ще не вийшов (без дотику ${view.idleMin} хв). Не бери руками — спитай ${c.who}.`,
        `   Якщо це аварія: --steal --reason="…" (лишить слід, який видно ПОТІМ).`] };
    }
    if (!afterTtl) {
      return { ok: false, code: 5, lines: [...head,
        `   ⏳ TTL ${TTL_MIN} хв ВИЙШОВ: без жодного дотику ${view.idleMin} хв (узято ${view.ageMin} хв тому), але замок НЕ звільнився сам:`,
        "   мовчазне звільнення за таймером — це крадіжка без імені й без причини.",
        `   Перехопити явно: --take --after-ttl (подію запишу я, причину теж).`] };
    }
    return { ok: true, kind: "take-after-ttl",
      note: `перехоплено після TTL: тримач ${c.who}, без дотику ${view.idleMin} хв, вік ${view.ageMin} хв (${c.at}), робив: ${c.reason}` };
  }

  if (op === "steal") {
    if (!reason.trim()) return { ok: false, code: 2, lines: ["🔴 --steal без --reason= заборонено: слід без причини за тиждень нічого не пояснює"] };
    if (!view.held) return { ok: false, code: 6, lines: ["🔴 красти нема чого — замок вільний; бери через --take"] };
    return { ok: true, kind: "steal", note: `відібрано в ${view.claim!.who} (${view.ageMin} хв): ${reason}` };
  }

  // release
  if (!view.held) return { ok: false, code: 6, lines: ["🔴 замок і так вільний — звільняти нічого"] };
  const c = view.claim!;
  if (c.who !== me) {
    return { ok: false, code: 7, lines: [
      `🔴 ТИ НЕ ТРИМАЧ — звільнити не можна, і мовчазний «успіх» тут був би найгіршим виходом.`,
      `   Замок належить ${c.who} з ${c.at} (${view.ageMin} хв): ${c.reason}`,
      "   Свій замок ти вже втратив або не брав. Дивись журнал: --status --log",
    ] };
  }
  return { ok: true, kind: "release", note: reason.trim() || "роботу завершено" };
}

/**
 * Чи тримає замок САМЕ цей актор ПРЯМО ЗАРАЗ.
 *
 * 🔴 ЗАМІРЯНО НА ЖИВОМУ ВИКАТІ 02.09.2026, і це був МІЙ дефект. Ланцюг вмикав дотик
 * лише після власного кроку `lockTake`; коли той крок переїхав у фазу `check`, фаза
 * `run` лишилась БЕЗ дотиків узагалі — тобто найдовша фаза (18 хв, із них 16 прогріву)
 * не продовжувала замок і не перевіряла, чи він іще наш. Заміряно в мить приймання:
 * `touchedAt` 20:41:22 при поточних 20:52:25 — 11 хв бездіяльності на замку, який
 * активно працював, при TTL 20 хв.
 *
 * ⚠️ Симптом підступний тим, що ВИГЛЯДАВ як робота: ланцюг ішов, кроки зеленіли, а
 * захист, заради якого все й робилось, був вимкнений. Дізнатись про це можна було
 * лише подивившись на `touchedAt` під час прогону — жоден крок про це не звітує.
 */
/**
 * 🏷 ПІДПИС УЧАСНИКА — ВЛАСТИВІСТЬ ЗАПУСКУ, А НЕ ЧАТУ, І САМЕ ТОМУ ЙОГО ЛЕГКО ЗАБУТИ.
 *
 * 📐 Дірку назвали незалежно два чати. `UTS_ACTOR` — змінна оточення: забув експорт —
 * ланцюг підписався ДЕФОЛТОМ, і в журналі зʼявився учасник, якого немає в жодній черзі.
 * Наслідок названо: умова ③ протоколу («у журналі є `release` попередника») стає
 * НЕДОКАЗОВОЮ, і черга або стоїть, або хтось бере замок помилково.
 *
 * 🔴 А ЗАМІР ПОКАЗАВ ГІРШЕ, НІЖ ОЧІКУВАЛОСЬ: дефолти в ланцюгу були РІЗНІ —
 * `deploy:run` у `take`/`release` і `deploy` у дотику та перевірці власності. Тобто без
 * `UTS_ACTOR` ланцюг брав замок одним імʼям, наступним кроком не впізнавав себе іншим,
 * падав кодом 7 — і лишав замок ВЗЯТИМ на фантомне імʼя, якого ніхто не звільнить.
 *
 * ⚠️ МЕЖА, НАЗВАНА ВГОЛОС: це лікує ПОРОЖНІЙ і ДЕФОЛТНИЙ підпис. Друга половина того
 * самого класу — чат ПЕРЕЙМЕНУВАВСЯ посеред роботи, і його попередній `release` за новим
 * імʼям не знаходиться — цією перевіркою НЕ лікується й не може: значення підпису сьогодні
 * нічого не каже про те, яким імʼям той самий учасник підписувався вчора. Для неї нижче
 * стоїть окреме ПОПЕРЕДЖЕННЯ (не відмова: новий учасник — законний стан).
 */
export const FORBIDDEN_ACTORS: readonly string[] = ["deploy", "deploy:run", "deploy:check", "node", "unknown"];

export function actorRefusal(actor: string | null | undefined): string | null {
  const a = (actor ?? "").trim();
  if (!a) return "🔴 UTS_ACTOR порожній: підпис у журналі — єдине, чим доводиться перехід ходу. "
    + "Постав `export UTS_ACTOR=\"<твоє імʼя з черги>\"` перед ланцюгом.";
  if (FORBIDDEN_ACTORS.includes(a.toLowerCase()))
    return `🔴 UTS_ACTOR=\"${a}\" — це ДЕФОЛТ, а не учасник черги. У журналі зʼявився б той, `
      + "кого немає в жодному промті, і умова ③ протоколу стала б недоказовою.";
  return null;
}

export function heldByMe(claim: Claim | null, me: string): boolean {
  return claim != null && claim.who === me;
}

/**
 * Чи це імʼя вперше зʼявляється в журналі.
 *
 * 🔴 ДРУГА ПОЛОВИНА КЛАСУ, І ВОНА НЕ ЛІКУЄТЬСЯ ВІДМОВОЮ. Чат перейменувався посеред
 * роботи — і його попередній `release` за НОВИМ імʼям не знаходиться, тобто умова ③
 * протоколу («у журналі є release попередника») перестає доводитись. Заборонити нове
 * імʼя не можна: новий учасник — цілком законний стан, і відмова блокувала б його.
 *
 * ✅ Тому не відмова, а ГУЧНЕ ПОПЕРЕДЖЕННЯ в мить взяття: воно нічого не зупиняє, але
 * ставить перед очима саме те питання, на якому сьогодні став чат — «це новий учасник
 * чи ти перейменувався?». Мовчання тут коштувало б рівно того самого простою.
 */
export function isNewActor(events: readonly LockEvent[], me: string): boolean {
  return !events.some((e) => e.who === me);
}

/** Чи бачить КОЛИШНІЙ тримач, що замок у нього забрали, і ким. Обидва шляхи втрати. */
export function lossFor(me: string, events: readonly LockEvent[]): LockEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.who === me && (e.kind === "take" || e.kind === "take-after-ttl")) return null;  // знову мій
    if ((e.kind === "steal" || e.kind === "take-after-ttl") && e.lostBy === me) return e;
  }
  return null;
}

// ─────────────────────────── файловий бік ───────────────────────────
export const claimPath = (repo: string) => `${repo}/.deploy-lock`;
export const logPath = (repo: string) => `${repo}/.deploy-lock.log`;

/**
 * 📍 КАНОНІЧНИЙ КАТАЛОГ ЗАМКА — АБСОЛЮТНИЙ, а не `process.cwd()`.
 *
 * 🔴 Заміряно 27.08.2026, і це найгірша знахідка дня: замок НЕ СЕРІАЛІЗУВАВ.
 * Вхідний рядок CLI резолвив каталог як `process.cwd()`, тож шлях залежав від того,
 * ЗВІДКИ покликали. На диску жили ДВА комплекти, обидва «робочі»:
 *   <докрут>/.deploy-lock.log          — 4 записи, останній 27.08 09:40 UTC
 *   <докрут>/backend/.deploy-lock(.log) — живий, там усі take/release від 26.08
 * Тобто чати писали в різні журнали в один день із різницею в годину, і кожен
 * бачив «вільно» у своїй половині диска.
 *
 * ⚠️ Ланцюг деплою при цьому кликав замок із `docRoot`, тобто в МЕРТВИЙ шлях:
 * `deploy:run` відзвітував би «замок мій» і поїхав `rm -rf dist` крізь чуже
 * приймання. Канонічним обрано `backend/` — той, де вже лежить жива історія,
 * щоб нічого не мігрувати.
 */
export const CANON_LOCK_DIR = process.env.UTS_LOCK_DIR ?? "/home/evraziat/uts.ua/dashboard/backend";

/** Шляхи, за якими замок жив РАНІШЕ. Перевіряються при взятті — див. `foreignHold`. */
export const LEGACY_LOCK_DIRS: readonly string[] = ["/home/evraziat/uts.ua/dashboard"];

/**
 * Чужа заявка за ІНШИМ відомим шляхом. `null` = ніде більше нікого.
 *
 * 🔴 Це і є ліки від «двох наглядачів, кожен у своє»: не довіра одному джерелу, а
 * ПРЯМЕ ПОРІВНЯННЯ двох. Одного лише канонічного шляху мало — він полагодив би
 * сьогоднішній випадок і лишив механізм, що розійдеться, щойно хтось покличе
 * інструмент із іншого каталогу.
 *
 * Чиста функція: заявки читає той, хто кличе, тож гейт саботажить ВХІД.
 */
export function foreignHold(
  others: readonly { dir: string; claim: Claim | null }[],
): { dir: string; claim: Claim } | null {
  for (const o of others) if (o.claim) return { dir: o.dir, claim: o.claim };
  return null;
}

export function readClaim(repo: string): Claim | null {
  const p = claimPath(repo);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as Claim; }
  catch { return { who: "невідомо", at: new Date(0).toISOString(), reason: "🔴 файл замка пошкоджено — вважаю зайнятим" }; }
}

export function readEvents(repo: string): LockEvent[] {
  const p = logPath(repo);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as LockEvent; } catch { return null; } })
    .filter((e): e is LockEvent => !!e);
}

function journal(repo: string, e: LockEvent): void { appendFileSync(logPath(repo), JSON.stringify(e) + "\n"); }

/** Взяття вільного замка — САМЕ `wx`: перевірка й створення однією операцією ядра. */
export function claimFresh(repo: string, c: Claim): boolean {
  try { writeFileSync(claimPath(repo), JSON.stringify(c, null, 2), { flag: "wx" }); return true; }
  catch { return false; }   // EEXIST — хтось устиг між нашим читанням і записом
}

/** Перехоплення — `rename(2)` поверх наявного: заміна атомарна, напівстану не буває. */
export function claimOver(repo: string, c: Claim): void {
  const tmp = `${claimPath(repo)}.${process.pid}.tmp`;   // поруч, бо rename атомарний лише в межах ФС
  writeFileSync(tmp, JSON.stringify(c, null, 2));
  renameSync(tmp, claimPath(repo));
}

export function applyVerdict(repo: string, v: Extract<Verdict, { ok: true }>, me: string, reason: string, prev: Claim | null): void {
  const now = new Date().toISOString();
  /**
   * 🔴 ДОТИК НЕ ПИШЕ В ЖУРНАЛ І НЕ ПЕРЕПИСУЄ ЗАЯВКУ. Він оновлює РІВНО одне поле —
   * `touchedAt`, — зберігаючи `who`/`at`/`reason` як були. Дві причини, обидві
   * заміряні на цьому ж проєкті:
   *   · журнал append-only і є ІСТОРІЄЮ; дотик на кожному кроці залив би його
   *     сотнями рядків за коло і зробив нечитанним саме тоді, коли по ньому
   *     відновлюють хід подій;
   *   · `lossFor` шукає в журналі take/steal — зайві події зламали б відповідь на
   *     питання «хто в мене забрав».
   * Тобто дотик змінює СТАН, а не історію.
   */
  if (v.kind === "touch") {
    if (!prev) throw new Error("дотик без заявки — стан замка змінився між рішенням і записом");
    writeFileSync(claimPath(repo), JSON.stringify({ ...prev, touchedAt: now }));
    return;
  }
  const c: Claim = { who: me, at: now, reason: reason.trim() || v.note, touchedAt: now };
  if (v.kind === "release") { unlinkSync(claimPath(repo)); }
  else if (v.kind === "take") { if (!claimFresh(repo, c)) throw new Error("гонка на взятті: замок перехопили між читанням і записом — спробуй ще раз"); }
  else { claimOver(repo, c); }
    // `lostBy` ставиться ЛИШЕ там, де замок у когось ЗАБРАЛИ. На звільненні його
  // не буває — інакше тримач «втрачав би» замок сам у себе, і `lossFor` брехав би.
  const took = v.kind === "steal" || v.kind === "take-after-ttl";
  journal(repo, { kind: v.kind, who: me, at: now, reason: reason.trim() || v.note, ...(took && prev ? { lostBy: prev.who } : {}) });
}

// ─────────────────────────── CLI ───────────────────────────
/**
 *   node dist/tools/checkoutLock.js --status [--log]
 *   node dist/tools/checkoutLock.js --take    --who=<чат> --reason="…" [--after-ttl]
 *   node dist/tools/checkoutLock.js --release --who=<чат> [--reason="…"]
 *   node dist/tools/checkoutLock.js --steal   --who=<чат> --reason="…"
 */
export function cli(argv: string[], repo: string, now = new Date()): { code: number; out: string[] } {
  const arg = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? "";
  const has = (n: string) => argv.includes(`--${n}`);
  const me = arg("who") || process.env.UTS_ACTOR || "";
  const reason = arg("reason");
  const view = viewLock(readClaim(repo), now);

  if (has("status") || argv.length === 0) {
    const out = view.held
      ? [`🔒 ЗАЙНЯТО: ${view.claim!.who} · ${view.ageMin} хв (${view.claim!.at})`,
         `   робить: ${view.claim!.reason}`,
         view.expired ? `   ⏳ TTL ${TTL_MIN} хв вийшов — але замок НЕ звільнився сам; перехоплення лише явне` : `   TTL ${TTL_MIN} хв ще йде`]
      : ["🔓 ВІЛЬНО"];
    if (me) { const l = lossFor(me, readEvents(repo)); if (l) out.push(`⚠️ твій замок забрав ${l.who} (${l.kind}) ${l.at}: ${l.reason}`); }
    if (has("log")) for (const e of readEvents(repo).slice(-20)) out.push(`   ${e.at} ${e.kind} ${e.who}${e.lostBy ? ` ← ${e.lostBy}` : ""}: ${e.reason}`);
    /**
     * ℹ️ Сказати ОДИН РАЗ, що за старим шляхом лишився журнал. Інакше через тиждень
     * хтось вирішить, що історія загубилась, — вона append-only і нікуди не дінеться.
     */
    for (const d of LEGACY_LOCK_DIRS) {
      if (d === repo) continue;
      const ev = readEvents(d);
      if (ev.length) out.push(`ℹ️ старий шлях ${d}: журнал на ${ev.length} записів, останній ${ev[ev.length - 1].at} — історія там, не загубилась`);
    }
    return { code: 0, out };
  }

  const op = has("take") ? "take" : has("release") ? "release" : has("steal") ? "steal"
    : has("touch") ? "touch" : null;
  if (!op) return { code: 2, out: ["🔴 потрібна дія: --status | --take | --release | --steal | --touch"] };
  if (!me) return { code: 2, out: ["🔴 --who= обовʼязково: замок без імені тримача не відповідає на єдине питання, заради якого існує"] };
  // 🔴 Порожній підпис уже відсіяно вище; тут відсівається ДЕФОЛТНИЙ — той, що
  // виглядає як імʼя, але не є учасником черги.
  const bad = actorRefusal(me);
  if (bad) return { code: 2, out: [bad] };
  if (op === "take" && !reason.trim()) return { code: 2, out: ["🔴 --take без --reason= заборонено: той, хто прийде, має бачити НЕ лише що зайнято, а й що саме робиться"] };



  /**
   * 🔴 ПЕРЕД ВЗЯТТЯМ — ПОДИВИТИСЬ ЗА ДРУГИМ ВІДОМИМ ШЛЯХОМ.
   * Мовчки взяти свою заявку, коли чужа лежить поруч, — це рівно та поведінка,
   * через яку замок не серіалізував. Відмова НАЗИВАЄ шлях і тримача.
   */
  if (op === "take") {
    const alien = foreignHold(
      LEGACY_LOCK_DIRS.filter((d) => d !== repo).map((d) => ({ dir: d, claim: readClaim(d) })),
    );
    if (alien) return { code: 4, out: [
      `🔴 ЗА СТАРИМ ШЛЯХОМ ЛЕЖИТЬ ЧУЖА ЗАЯВКА — не беру.`,
      `   ${alien.dir}/.deploy-lock`,
      `   тримає: ${alien.claim.who} (${alien.claim.at})`,
      `   робить: ${alien.claim.reason}`,
      `   Каталог замка колись залежав від cwd, тож ця заявка справжня, просто не там.`,
      `   Домовитись із тримачем; зняти можна лише руками, з того ж каталогу.`,
    ] };
  }

  /**
   * 🔴 ДОТИК ІДЕ ОКРЕМИМ ШЛЯХОМ, ПІСЛЯ перевірки чужих заявок і ПЕРЕД спільним `decide`.
   * Порядок не випадковий і не косметичний: `#250j` бере зріз джерела МІЖ гілкою
   * `take` і викликом `decide`, тож блок, вставлений між ними, вирізає з того зрізу
   * перевірку `foreignHold` — гейт червонів на робочому коді. Це та сама крихка межа,
   * від якої застерігає правило 9. Дотику ця сусідство нічим не заважає: `foreignHold`
   * працює лише під `op === "take"`.
   */
  if (op === "touch") {
    const v = decide("touch", view, me, reason, false);
    if (!v.ok) return { code: v.code, out: v.lines };
    applyVerdict(repo, v, me, reason, view.claim);
    return { code: 0, out: [`✅ дотик: замок твій, TTL бездіяльності відлічується наново`] };
  }

  const v = decide(op, view, me, reason, has("after-ttl"));
  if (!v.ok) return { code: v.code, out: v.lines };
  const newcomer = op === "take" && isNewActor(readEvents(repo), me);
  applyVerdict(repo, v, me, reason, view.claim);
  const out = [`✅ ${v.kind}: ${v.note}`];
  if (newcomer) out.push(
    `⚠️ «${me}» ЩЕ НЕ ЗУСТРІЧАВСЯ В ЖУРНАЛІ. Якщо це новий учасник — гаразд.`,
    "   Якщо ти ПЕРЕЙМЕНУВАВСЯ — твій попередній `release` лежить під СТАРИМ імʼям,",
    "   і той, хто йде за тобою, не доведе перехід ходу. Назви обидва імені в черзі.");
  return { code: 0, out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // 🔴 НЕ process.cwd(): саме він робив шлях залежним від того, звідки покликали.
  // `cli(argv, repo)` і далі бере каталог аргументом, тож тести з власними tmp-каталогами
  // не зачеплені — змінюється РІВНО вхід у CLI.
  const r = cli(process.argv.slice(2), CANON_LOCK_DIR);
  console.log(r.out.join("\n"));
  process.exit(r.code);
}
