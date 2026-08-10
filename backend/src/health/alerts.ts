import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../db/pool.js";
import { rolesCacheState } from "../auth/rbac.js";
import { buildVersion } from "../version.js";
import { runReadOnly } from "../ai/readQuery.js";
import { MONITORED_JOBS } from "../jobs/monitoredJobs.js";

/**
 * 🚨 СИГНАЛІЗАЦІЯ — щоб про поломку система казала САМА (Крок 2).
 *
 * Моніторимо РІВНО наші аварії, кожну з яких ми вже пережили:
 *  1. ВЕРСІЯ    — рантайм ≠ HEAD прод-гілки. Це буквально 11.4 год старого коду.
 *  2. QUERY_DB  — синтетичний `SET ROLE ai_readonly`. Про поломку дізнались випадково через 3 год.
 *  3. СИНК      — sync_state застарів або падає поспіль.
 *  4. ДЖОБИ     — остання успішна робота старша за 2× частоти (durable `job_runs`).
 *  5. ВІДЖЕТИ   — хоч один віджет власника падає.
 *
 * 🔴 ГОЛОВНЕ ПРАВИЛО — «НЕ ЗНАЮ» ≠ «ДОБРЕ».
 * Сигналізація не має вміти мовчати через власну поломку. Якщо перевірка не змогла
 * виконатись (виняток, недоступна БД, нечитабельний git-ref) — це ТРИВОГА рівня
 * `check_failed`, а не тиша. Ми двічі горіли на хибно-зеленому: health віддавав 200
 * при старому коді, і набір показував «0 падінь» без двох тестів.
 *
 * Банер малюється ЛИШЕ на проблемі: «все добре» зеленою плашкою не показуємо —
 * постійний індикатор перестають помічати рівно тоді, коли він змінює колір.
 */

export type Severity = "critical" | "warning";

export interface Alert {
  /** Стабільний ключ — фронт по ньому дедуплікує й не блимає між опитуваннями. */
  id: string;
  severity: Severity;
  /** ЩО зламалось — коротко, одним рядком. */
  title: string;
  /** Деталі: цифри, назви, коди. */
  detail: string;
  /** ЩО РОБИТИ далі — конкретна дія, а не «розберіться». */
  action: string;
  /** КОЛИ почалось (ISO) — null, якщо момент початку невідомий. */
  since: string | null;
}

export interface AlertsState {
  alerts: Alert[];
  checkedAt: string;
  /** Скільки перевірок оголошено і скільки реально відпрацювало. */
  checksDeclared: number;
  checksRan: number;
}

const ISO = (d: Date | string | null | undefined) =>
  d ? new Date(d).toISOString() : null;

// ─────────────────────── 1. ВЕРСІЯ ───────────────────────

/**
 * HEAD гілки з `.git` БЕЗ subprocess: читаємо `.git/HEAD` → ref-файл → fallback у
 * `packed-refs`. Кидаємо при будь-якій невдачі — виклик обгорнутий і перетворить
 * це на тривогу `check_failed`, бо «не зміг прочитати» не означає «все збігається».
 */
async function gitHeadSha(): Promise<string> {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const gitDir = path.join(root, ".git");
  const head = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
  if (!head.startsWith("ref:")) return head; // detached HEAD — вже sha
  const ref = head.slice(4).trim();
  try {
    return (await readFile(path.join(gitDir, ref), "utf8")).trim();
  } catch {
    const packed = await readFile(path.join(gitDir, "packed-refs"), "utf8");
    const line = packed.split("\n").find((l) => l.endsWith(" " + ref));
    if (!line) throw new Error(`ref ${ref} не знайдено ні у refs/, ні в packed-refs`);
    return line.split(" ")[0].trim();
  }
}

async function checkVersion(): Promise<Alert[]> {
  const built = buildVersion();
  if (built.sha === "unknown") {
    return [{
      id: "version:unknown", severity: "critical",
      title: "Невідомо, яку версію крутить сервер",
      detail: "dist/version.json відсутній або порожній — звірити рантайм із гілкою неможливо.",
      action: "Перезібрати бекенд (npm run build) і перезапустити процес.",
      since: null,
    }];
  }
  const head = await gitHeadSha(); // кине → перетвориться на check_failed
  if (head !== built.sha) {
    return [{
      id: "version:mismatch", severity: "critical",
      title: "Сервер крутить СТАРИЙ код",
      detail: `Рантайм ${built.shortSha}, а гілка ${built.branch ?? "?"} на ${head.slice(0, 7)}. `
        + `Зібрано ${built.builtAt ?? "?"}.`,
      action: "Перезібрати (npm run build) і перезапустити node ПО comm=node — pgrep -f ловить чужий процес.",
      since: built.builtAt,
    }];
  }
  return [];
}

// ─────────────────────── 2. QUERY_DB ───────────────────────

async function checkQueryDb(): Promise<Alert[]> {
  // Синтетичний запит саме через прод-шлях `runReadOnly` — з `SET LOCAL ROLE`.
  // Перевіряти чимось іншим означало б перевіряти не те, що ламалось.
  const r = await runReadOnly("SELECT 1 AS ok");
  if (!r.ok) {
    return [{
      id: "query_db:down", severity: "critical",
      title: "AI-чат і віджети не можуть читати БД",
      detail: `runReadOnly впав: ${r.error}`,
      action: r.error.includes("set role")
        ? "Роль ai_readonly недоступна: прогнати npm run migrate (GRANT ... WITH SET TRUE)."
        : "Перевірити доступність БД і права ролі ai_readonly.",
      since: null,
    }];
  }
  return [];
}

// ─────────────────────── 3. СИНХРОНІЗАЦІЯ ───────────────────────

const SYNC_STALE_MIN = 60; // 2× частоти syncKommo (30 хв)

async function checkSync(): Promise<Alert[]> {
  const r = await pool.query<{ last_success_at: Date | null; consecutive_failures: number; last_error: string | null }>(
    `SELECT last_success_at, consecutive_failures, last_error FROM sync_state WHERE id = 1`);
  const row = r.rows[0];
  if (!row) {
    return [{
      id: "sync:no_state", severity: "critical",
      title: "Синхронізація не звітує взагалі",
      detail: "У sync_state немає рядка — джоба жодного разу не записала свій стан.",
      action: "Перевірити, чи запущений процес і чи проходить міграція.",
      since: null,
    }];
  }
  const out: Alert[] = [];
  if (!row.last_success_at) {
    out.push({
      id: "sync:never", severity: "critical",
      title: "Синхронізація з Kommo жодного разу не пройшла успішно",
      detail: `Остання помилка: ${row.last_error ?? "—"}`,
      action: "Перевірити доступ до Kommo API (не в бані?) і KOMMO_PAUSED.",
      since: null,
    });
  } else {
    const ageMin = Math.round((Date.now() - new Date(row.last_success_at).getTime()) / 60000);
    if (ageMin > SYNC_STALE_MIN) {
      out.push({
        id: "sync:stale", severity: "critical",
        title: "Дані з CRM застаріли",
        detail: `Останній успішний синк ${ageMin} хв тому (норма ≤${SYNC_STALE_MIN} при частоті 30 хв).`
          + (row.last_error ? ` Остання помилка: ${row.last_error}` : ""),
        action: "Перевірити /api/health, чи не активний KOMMO_PAUSED і чи не висить job_locks.",
        since: ISO(row.last_success_at),
      });
    }
  }
  if (Number(row.consecutive_failures) > 0) {
    out.push({
      id: "sync:failing", severity: Number(row.consecutive_failures) >= 3 ? "critical" : "warning",
      title: `Синхронізація падає поспіль (${row.consecutive_failures})`,
      detail: `Остання помилка: ${row.last_error ?? "—"}`,
      action: "Подивитись лог процесу; при 403/429 від Kommo — знизити темп.",
      since: null,
    });
  }
  return out;
}

// ─────────────────────── 4. ДЖОБИ ───────────────────────

async function checkJobs(): Promise<Alert[]> {
  const rows = (await pool.query<{ name: string; last_success_at: Date | null; last_error: string | null; last_error_at: Date | null }>(
    `SELECT name, last_success_at, last_error, last_error_at FROM job_runs`)).rows;
  const byName = new Map(rows.map((r) => [r.name, r]));
  const uptimeMin = process.uptime() / 60;
  const out: Alert[] = [];
  /**
   * 🔴 ПОМИЛКА АКТУАЛЬНА, ЛИШЕ ЯКЩО ПІСЛЯ НЕЇ НЕ БУЛО УСПІХУ (виправлено 10.08.2026).
   *
   * Тут стояло просто `rec.last_error`, і це було ПРАВИЛЬНО — але не саме по собі,
   * а тому що `runJob` занулював `last_error` на кожному успіху. Тобто ненульова
   * помилка за побудовою була свіжішою за успіх.
   *
   * У `45465f5` я прибрав те занулення (щоб не втрачати причину аварій — саме так
   * зник текст помилки, що почала простій 14 год 52 хв). Інваріанту прибрав, а
   * читача не перевірив: банер «падала після останнього успіху» став вічним і
   * почав стверджувати неправду. Заміряно: `syncCalls` впала 09:15, одужала 09:35,
   * банер висів годинами.
   *
   * Це вже третій баг цього класу за добу (чипи новий/постійний, цей банер, мовчазна
   * сигналізація): умова спирається на гарантію, яку дає хтось поруч.
   */
  const errorIsCurrent = (r: { last_error: string | null; last_error_at: Date | null; last_success_at: Date | null }): boolean =>
    Boolean(r.last_error) && r.last_error_at != null
    && (r.last_success_at == null || r.last_error_at > r.last_success_at);
  for (const j of MONITORED_JOBS) {
    const rec = byName.get(j.name);
    const graceMin = j.everyMin * 2;
    // Після рестарту джоба ще не встигла відпрацювати — це не поломка. Але щойно
    // минув подвійний інтервал аптайму, мовчання вже означає поломку, а не старт.
    if (!rec?.last_success_at) {
      if (uptimeMin > graceMin) {
        out.push({
          id: `job:${j.name}:never`, severity: "critical",
          title: `Джоба «${j.name}» не відпрацювала жодного разу`,
          detail: `Процес живе ${Math.round(uptimeMin)} хв, штатна частота ${j.everyMin} хв. ${j.why}.`
            + (rec && errorIsCurrent(rec) ? ` Остання помилка: ${rec.last_error}` : ""),
          action: `Перевірити лог процесу на «${j.name} failed» і розклад cron.`,
          since: ISO(rec?.last_error_at ?? null),
        });
      }
      continue;
    }
    const ageMin = Math.round((Date.now() - new Date(rec.last_success_at).getTime()) / 60000);
    if (ageMin > graceMin) {
      out.push({
        id: `job:${j.name}:stale`, severity: "critical",
        title: `Джоба «${j.name}» мовчить ${ageMin} хв`,
        detail: `Штатна частота ${j.everyMin} хв, поріг ${graceMin} хв. ${j.why}.`
          + (errorIsCurrent(rec) ? ` Остання помилка: ${rec.last_error}` : ""),
        action: `Перевірити лог на «${j.name} failed»; якщо помилка схемна — прогнати npm run migrate.`,
        since: ISO(rec.last_success_at),
      });
    } else if (errorIsCurrent(rec)) {
      out.push({
        id: `job:${j.name}:error`, severity: "warning",
        title: `Джоба «${j.name}» падала після останнього успіху`,
        detail: `${rec.last_error}`,
        action: "Подивитись лог; якщо повторюється — тривога стане критичною, коли мине поріг.",
        since: ISO(rec.last_error_at),
      });
    }
  }
  return out;
}

// ─────────────────────── 5. ВІДЖЕТИ ───────────────────────

async function checkWidgets(): Promise<Alert[]> {
  const widgets = (await pool.query<{ id: number; title: string; sql: string }>(
    `SELECT id, title, sql FROM ai_widgets ORDER BY id`)).rows;
  const broken: string[] = [];
  for (const w of widgets) {
    const r = await runReadOnly(w.sql);
    if (!r.ok) broken.push(`#${w.id} «${w.title}»: ${r.error}`);
  }
  if (!broken.length) return [];
  return [{
    id: "widgets:broken", severity: "critical",
    title: broken.length === 1 ? "Віджет у «Моїх звітах» не будується" : `Віджети не будуються (${broken.length})`,
    detail: broken.join(" · "),
    action: "Відкрити «Мої звіти»; якщо помилка про роль — прогнати npm run migrate, якщо про колонку — виправити SQL віджета.",
    since: null,
  }];
}

/**
 * 🔴 РОЛЬ-КЕШ RBAC. Стан, у якому система працює НЕПРАВИЛЬНО і мовчить — рівно те,
 * заради чого будувалась ця сигналізація.
 *
 * Порожній кеш означав би, що гейти доступу не мають на чому працювати. Після
 * 31.07.2026 це вже не «відкрито всім» (обидві функції fail-closed, і сервер із
 * порожнім кешем не стартує), але тоді це «закрито всім» — сайт живий, а люди не
 * бачать своїх вкладок. Обидва стани треба показувати, а не з'ясовувати по скаргах.
 *
 * Задавнений кеш (періодичний refresh раз на 10 хв мовчки помер) — попередження:
 * правки ролей в адмінці перестають діяти, і про це теж ніхто не дізнається сам.
 */
async function checkRoleCache(): Promise<Alert[]> {
  const { size, ageMinutes } = rolesCacheState();
  if (size === 0) {
    return [{
      id: "roles:empty", severity: "critical",
      title: "Роль-кеш RBAC порожній",
      detail: "Гейти доступу працюють у режимі fail-closed: жодна роль не бачить своїх вкладок. "
        + "Причина зазвичай — недоступна БД на старті або порожня таблиця roles.",
      action: "Перевірити доступність БД і `SELECT count(*) FROM roles`; далі рестарт процесу.",
      since: null,
    }];
  }
  // Поріг = 3× частоти джоби (*/10). Менше давало б хибні тривоги на тіку.
  if (ageMinutes != null && ageMinutes > 30) {
    return [{
      id: "roles:stale", severity: "warning",
      title: `Роль-кеш не оновлювався ${ageMinutes} хв`,
      detail: "Періодичний refreshRoles (кожні 10 хв) не відпрацьовує. Зміни ролей в адмінці "
        + "не набувають чинності до рестарту.",
      action: "Подивитись у логах «periodic refreshRoles failed» і перевірити БД.",
      since: null,
    }];
  }
  return [];
}

// ─────────────────────── збірка ───────────────────────

const CHECKS: { id: string; label: string; run: () => Promise<Alert[]> }[] = [
  { id: "version", label: "версія коду", run: checkVersion },
  { id: "query_db", label: "доступ AI до БД", run: checkQueryDb },
  { id: "sync", label: "синхронізація з CRM", run: checkSync },
  { id: "jobs", label: "фонові джоби", run: checkJobs },
  { id: "widgets", label: "віджети власника", run: checkWidgets },
  { id: "roles", label: "роль-кеш RBAC", run: checkRoleCache },
];

/** Перелік оголошених джерел банера — щоб тест міг довести, що нове ДОДАНО, а не лише написане. */
export function declaredCheckIds(): string[] {
  return CHECKS.map((c) => c.id);
}

/**
 * Зібрати стан. Кожна перевірка ізольована: її падіння НЕ глушить решту і саме
 * стає тривогою. Плюс мета-інваріант `checksRan == checksDeclared` — щоб «жодної
 * тривоги» не могло означати «жодна перевірка не виконалась».
 */
export async function collectAlerts(): Promise<AlertsState> {
  const alerts: Alert[] = [];
  let ran = 0;
  for (const c of CHECKS) {
    try {
      alerts.push(...(await c.run()));
      ran++;
    } catch (err) {
      ran++;
      alerts.push({
        id: `check_failed:${c.id}`, severity: "critical",
        title: `Перевірка «${c.label}» не змогла виконатись`,
        detail: `${err instanceof Error ? err.message : String(err)} — це НЕ означає «все гаразд»: `
          + "стан цього джерела зараз невідомий.",
        action: "Подивитись лог сервера; поки перевірка не працює, поломку в цій зоні ми не побачимо.",
        since: null,
      });
    }
  }
  if (ran !== CHECKS.length) {
    alerts.push({
      id: "check_failed:meta", severity: "critical",
      title: "Сигналізація відпрацювала не повністю",
      detail: `Виконалось ${ran} перевірок із ${CHECKS.length} — частина джерел не перевірена.`,
      action: "Подивитись лог сервера: збірка тривог перервалась.",
      since: null,
    });
  }
  return {
    alerts,
    checkedAt: new Date().toISOString(),
    checksDeclared: CHECKS.length,
    checksRan: ran,
  };
}

/** Для тестів і маніфесту: скільки джерел оголошено. */
export const DECLARED_CHECKS = CHECKS.map((c) => c.id);
