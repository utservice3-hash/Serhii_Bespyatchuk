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

export interface Claim { who: string; at: string; reason: string }
export type EventKind = "take" | "take-after-ttl" | "steal" | "release";
export interface LockEvent extends Claim { kind: EventKind; lostBy?: string }

export interface LockView {
  held: boolean;
  claim: Claim | null;
  ageMin: number;
  /** Прострочений ≠ вільний. Обчислюється НА ЧИТАННІ й сам нічого не звільняє. */
  expired: boolean;
}

export function viewLock(claim: Claim | null, now: Date): LockView {
  if (!claim) return { held: false, claim: null, ageMin: 0, expired: false };
  const ageMin = Math.floor((now.getTime() - new Date(claim.at).getTime()) / 60_000);
  return { held: true, claim, ageMin, expired: ageMin >= TTL_MIN };
}

export type Verdict =
  | { ok: true; kind: EventKind; note: string }
  | { ok: false; code: number; lines: string[] };

/**
 * ЧИСТЕ РІШЕННЯ — уся політика тут, і саботується вона входом, а не файловою системою.
 *
 * 🔴 TTL НЕ ЗВІЛЬНЯЄ САМ. Автозвільнення за таймером — це та сама крадіжка, тільки
 * без імені й без причини: замок зникає, а в журналі порожньо. Прострочений замок
 * лишається ЗАЙНЯТИМ, і забрати його можна лише ЯВНОЮ дією, яка лишає подію.
 */
export function decide(
  op: "take" | "release" | "steal",
  view: LockView,
  me: string,
  reason: string,
  afterTtl: boolean,
): Verdict {
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
        `   TTL ${TTL_MIN} хв ще не вийшов. Не бери руками — спитай ${c.who}.`,
        `   Якщо це аварія: --steal --reason="…" (лишить слід, який видно ПОТІМ).`] };
    }
    if (!afterTtl) {
      return { ok: false, code: 5, lines: [...head,
        `   ⏳ TTL ${TTL_MIN} хв ВИЙШОВ (${view.ageMin} хв), але замок НЕ звільнився сам:`,
        "   мовчазне звільнення за таймером — це крадіжка без імені й без причини.",
        `   Перехопити явно: --take --after-ttl (подію запишу я, причину теж).`] };
    }
    return { ok: true, kind: "take-after-ttl",
      note: `перехоплено після TTL: тримач ${c.who}, вік ${view.ageMin} хв (${c.at}), робив: ${c.reason}` };
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
  const c: Claim = { who: me, at: now, reason: reason.trim() || v.note };
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
    return { code: 0, out };
  }

  const op = has("take") ? "take" : has("release") ? "release" : has("steal") ? "steal" : null;
  if (!op) return { code: 2, out: ["🔴 потрібна дія: --status | --take | --release | --steal"] };
  if (!me) return { code: 2, out: ["🔴 --who= обовʼязково: замок без імені тримача не відповідає на єдине питання, заради якого існує"] };
  if (op === "take" && !reason.trim()) return { code: 2, out: ["🔴 --take без --reason= заборонено: той, хто прийде, має бачити НЕ лише що зайнято, а й що саме робиться"] };

  const v = decide(op, view, me, reason, has("after-ttl"));
  if (!v.ok) return { code: v.code, out: v.lines };
  applyVerdict(repo, v, me, reason, view.claim);
  return { code: 0, out: [`✅ ${v.kind}: ${v.note}`] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = cli(process.argv.slice(2), process.env.UTS_REPO ?? process.cwd());
  console.log(r.out.join("\n"));
  process.exit(r.code);
}
