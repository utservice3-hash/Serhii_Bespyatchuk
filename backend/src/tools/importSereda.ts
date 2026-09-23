/**
 * 🎓 ІМПОРТ АКАДЕМІЇ SEREDA В ДАШБОРД — ОДНОРАЗОВО (23.09.2026).
 *
 * Правило перекладу живе в `core/serediaImport.ts`; тут — мережа, файли й запис. Інструмент навмисно
 * КОНСОЛЬНИЙ, а не роут: це разова дія з чужим токеном, і давати їй постійні двері в застосунку — зайва
 * поверхня. Після переносу дашборд від Sereda не залежить.
 *
 * Запуск (на сервері, у теці `backend`):
 *   SEREDA_TOKEN=… node dist/tools/importSereda.js --dry     # лише порахувати, нічого не писати
 *   SEREDA_TOKEN=… node dist/tools/importSereda.js --write    # записати в БД і завантажити файли
 *
 * 🔴 `--dry` НЕ ТОРКАЄТЬСЯ НІ БД, НІ ДИСКА — інакше «подивитись, що буде» саме́ й було б зміною.
 * 🔴 ІДЕМПОТЕНТНО: повторний `--write` оновлює ті самі рядки за `external_id`; файл, що вже лежить і
 *    збігається розміром, удруге не качається (і це видно числом «пропущено»).
 * 🔴 КУРСИ ПРИХОДЯТЬ ЧЕРНЕТКАМИ й з аудиторією «менеджер»: опублікований курс одразу потрапив би в
 *    знаменник навчання КАНДИДАТА, і його відсоток обвалився б (рішення Романа 23.09: спершу перегляд).
 */
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { pool } from "../db/pool.js";
import { coursePlan, totals, importCourses, type MaterialPlan, type SerediaCourse } from "../core/serediaImport.js";

const BASE = process.env.SEREDA_BASE ?? "https://utseducation.sereda.ai";
const PROJECT = process.env.SEREDA_PROJECT ?? "39d73c9a-41ab-4952-b65e-e51f89ee5622";
const TOKEN = process.env.SEREDA_TOKEN ?? "";
const TRAIN_DIR = path.join(process.cwd(), "training");
const WRITE = process.argv.includes("--write");

const api = (p: string) => (p.startsWith("http") ? p : `${BASE}${p}`);
const auth = { accept: "application/json", authorization: `Bearer ${TOKEN}` };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(api(url), { headers: auth });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return (await r.json()) as T;
}

/** Курси каталогу з повним складом уроків: список → курс із модулями → кожен урок окремо (там і вміст). */
async function fetchCourses(): Promise<SerediaCourse[]> {
  const list = await getJson<{ data: { id: string }[] }>(`/api/v1/projects/${PROJECT}/academy/courses?per_page=200`);
  const out: SerediaCourse[] = [];
  for (const { id } of list.data) {
    const c = (await getJson<{ data: SerediaCourse & { modules?: { id: string; title: string; sort_order?: number; lessons?: { id: string }[] }[] } }>(
      `/api/v1/projects/${PROJECT}/academy/courses/${id}?view=learner`)).data;
    const modules: NonNullable<SerediaCourse["modules"]> = [];
    for (const m of c.modules ?? []) {
      const lessons: NonNullable<NonNullable<SerediaCourse["modules"]>[number]["lessons"]> = [];
      for (const l of m.lessons ?? []) lessons.push((await getJson<{ data: NonNullable<typeof lessons>[number] }>(`/api/v1/projects/${PROJECT}/academy/lessons/${l.id}`)).data);
      modules.push({ id: m.id, title: m.title, sort_order: m.sort_order ?? null, lessons });
    }
    out.push({ ...c, modules });
    console.log(`  ✓ ${c.title} — модулів ${modules.length}, уроків ${modules.reduce((a, m) => a + (m.lessons?.length ?? 0), 0)}`);
  }
  return out;
}

/** Файл із Sereda на наш диск. `resolve` — спершу забрати підписану адресу (вкладення віддаються так). */
async function download(m: Extract<MaterialPlan, { kind: "file" }>): Promise<{ storedName: string; size: number; skipped: boolean }> {
  const ext = path.extname(m.file.name).slice(0, 12).replace(/[^.\w]/g, "") || ".pdf";
  const storedName = `sereda-${m.externalId.replace(/[^\w-]/g, "_")}${ext}`;
  const dest = path.join(TRAIN_DIR, storedName);
  const have = await stat(dest).catch(() => null);
  if (have && (m.file.sizeBytes == null || have.size === m.file.sizeBytes)) return { storedName, size: have.size, skipped: true };

  let url = m.file.url;
  if (m.file.resolve) {
    const j = await getJson<{ data?: { redirect_url?: string }; redirect_url?: string }>(url);
    const redirect = j.data?.redirect_url ?? j.redirect_url;
    if (!redirect) throw new Error(`немає redirect_url для ${m.title}`);
    url = redirect;
  }
  const r = await fetch(url, { headers: url.startsWith(BASE) ? auth : {} });
  if (!r.ok) throw new Error(`${r.status} файл «${m.file.name}»`);
  const buf = Buffer.from(await r.arrayBuffer());
  await mkdir(TRAIN_DIR, { recursive: true });
  await writeFile(dest, buf);
  return { storedName, size: buf.length, skipped: false };
}

async function main() {
  if (!TOKEN) { console.error("🔴 Немає SEREDA_TOKEN — інструменту нема з чим іти в Академію"); process.exit(2); }
  console.log(`Академія Sereda: ${BASE}\nЗабираю курси…`);
  const raw = await fetchCourses();
  const plans = raw.map((c) => coursePlan(c, api, PROJECT));
  const t = totals(plans);
  console.log(`\n📋 ПЛАН: курсів ${t.courses} · тем ${t.folders} · матеріалів ${t.materials}`
    + ` (текстів ${t.text}, файлів ${t.files}, посилань-відео ${t.embeds}) · файлів на ${(t.bytes / 1048576).toFixed(1)} МБ`);

  if (!WRITE) { console.log("\n— це `--dry`: у базу й на диск НЕ записано нічого. Запис: --write"); await pool.end(); return; }

  const actor = (await pool.query<{ id: number }>(
    `SELECT id FROM users WHERE COALESCE(role_override, role) = 'admin' AND is_active ORDER BY id LIMIT 1`)).rows[0]?.id ?? null;
  const counts = await importCourses(pool as never, plans, actor, download);

  console.log(`\n✅ ЗАПИСАНО: курсів ${counts.courses} · тем ${counts.folders} · матеріалів ${counts.materials}`
    + ` · файлів завантажено ${counts.filesSaved} (${(counts.bytes / 1048576).toFixed(1)} МБ), уже було ${counts.filesSkipped}`);
  console.log("Курси створено ЧЕРНЕТКАМИ (аудиторія «менеджер») — публікує людина в «Навчанні».");
  await pool.end();
}

main().catch(async (e) => { console.error("🔴", (e as Error).message); await pool.end().catch(() => undefined); process.exit(1); });
