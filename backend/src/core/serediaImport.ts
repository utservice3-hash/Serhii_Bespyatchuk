/**
 * 🎓 ОДНОРАЗОВИЙ ПЕРЕНОС АКАДЕМІЇ SEREDA В ДАШБОРД (23.09.2026, рішення Романа: «весь функціонал Sereda — це
 * дашборд, переносимо все; це одноразова акція, далі навчання живе на нашому сервері»).
 *
 * Тут — ЧИСТЕ правило перекладу, без мережі й без БД: курс Sereda → курс дашборда, модуль → папка, урок →
 * матеріали. Мережу й запис робить `tools/importSereda.ts`, і він не вирішує нічого сам.
 *
 * 🔴 ОДИН УРОК SEREDA → КІЛЬКА МАТЕРІАЛІВ ДАШБОРДА, і це не примха. У Sereda урок — контейнер: усередині
 * текст, відео, презентація і скільки завгодно вкладень одночасно. У нас матеріал — рівно одна річ
 * (`training_materials.kind`). Складати їх в один матеріал означало б загубити все, крім першого.
 *
 * 🔴 ТЕКСТ ПЕРЕТВОРЮЄТЬСЯ НА ПЛАСКИЙ, бо екран навчання малює його `white-space: pre-wrap`, тобто HTML
 * показав би теги. Заміряно на джерелі: у текстах лише `<p>` і `<span>`, тож втрата — це відступи, а не зміст.
 * Малювати HTML — окрема зміна з власним прийманням (і власним рішенням про безпеку чужої розмітки).
 *
 * 🔴 ІДЕМПОТЕНТНІСТЬ ЗА `external_id`: ключ матеріалу — `<id уроку>:<рід>:<n>`, тож повторний запуск оновлює
 * той самий рядок, а не плодить копії. Ключ будується ТУТ, щоб прев'ю й запис не розійшлись.
 * Тримають #700–#702.
 */

export interface SerediaAttachment { id: string; name?: string | null; original_filename?: string | null; mime_type?: string | null; file_size_bytes?: number | string | null }
export interface SerediaLesson {
  id: string; title: string; type?: string | null; content?: string | null; description?: string | null;
  is_required?: boolean | null; sort_order?: number | null; duration_seconds?: number | null;
  video_url?: string | null; video_provider?: string | null; presentation_url?: string | null;
  attachments?: SerediaAttachment[] | null;
}
export interface SerediaModule { id: string; title: string; sort_order?: number | null; lessons?: SerediaLesson[] | null }
export interface SerediaCourse {
  id: string; title: string; description?: string | null; short_description?: string | null;
  estimated_duration?: number | string | null; modules?: SerediaModule[] | null;
}

/** Що саме треба покласти в дашборд. `file` — те, що доведеться завантажити з Sereda. */
/**
 * 🔴 ДВА ШЛЯХИ ДО ФАЙЛА, І ЦЕ ЗАМІРЯНО, А НЕ ПРИПУЩЕНО. Презентація віддається САМИМ файлом (заміряно:
 * `application/pdf`, 5.2 МБ), а вкладення — JSON-ом `{redirect_url, filename}` із підписаним посиланням у
 * сховище. Тому в плані стоїть `resolve`: `true` означає «спершу забери адресу, потім файл».
 */
export interface SerediaFile { url: string; name: string; mime: string | null; sizeBytes: number | null; resolve: boolean }

export type MaterialBody =
  | { externalId: string; title: string; kind: "text"; content: string }
  | { externalId: string; title: string; kind: "video_embed" | "link"; url: string; content: string | null }
  | { externalId: string; title: string; kind: "file"; file: SerediaFile; content: string | null };
export type MaterialPlan = MaterialBody & { required: boolean; position: number };
export interface FolderPlan { externalId: string; title: string; position: number; materials: MaterialPlan[] }
export interface CoursePlan { externalId: string; title: string; description: string | null; folders: FolderPlan[] }

/** HTML Sereda → плаский текст: абзац і `<br>` стають переносом, теги зникають, сутності розкриваються. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    .split("\n").map((l) => l.trim()).join("\n").trim();
}

const EMBED = /^https?:\/\/(www\.)?(youtu\.be|youtube\.com|vimeo\.com|loom\.com)\//i;
const fileName = (a: SerediaAttachment, fallback: string) =>
  (a.name || a.original_filename || fallback).replace(/\s+/g, " ").trim().slice(0, 190);
const num = (v: unknown) => (v == null || v === "" ? null : Number(v));

/**
 * Урок → матеріали, у сталому порядку: текст → відео → презентація → вкладення. Порядок фіксований, бо він
 * визначає нумерацію в `external_id`, а її не можна міняти між прогонами — інакше другий прогін створить дублі.
 */
export function lessonMaterials(l: SerediaLesson, base: number, api: (path: string) => string, projectId: string): MaterialPlan[] {
  const out: MaterialPlan[] = [];
  const required = l.is_required !== false;
  const text = htmlToText(l.content ?? "");
  const desc = htmlToText(l.description ?? "") || null;
  const push = (m: MaterialBody) => out.push({ ...m, required, position: base + out.length });

  if (text) push({ externalId: `${l.id}:text`, title: l.title, kind: "text", content: text });
  if (l.video_url) {
    const url = l.video_url;
    if (EMBED.test(url)) push({ externalId: `${l.id}:video`, title: l.title, kind: "video_embed", url, content: desc });
    else push({ externalId: `${l.id}:video`, title: l.title, kind: "file", content: desc,
      file: { url, name: `${l.title}.mp4`.slice(0, 190), mime: "video/mp4", sizeBytes: null, resolve: false } });
  }
  if (l.presentation_url) push({ externalId: `${l.id}:pres`, title: `${l.title} — презентація`.slice(0, 190), kind: "file", content: null,
    file: { url: api(l.presentation_url), name: `${l.title}.pdf`.slice(0, 190), mime: "application/pdf", sizeBytes: null, resolve: false } });
  (l.attachments ?? []).forEach((a, i) => push({
    externalId: `${l.id}:att:${a.id}`, kind: "file", content: null,
    title: (out.length === 0 ? l.title : fileName(a, l.title)).slice(0, 190),
    file: { url: api(`/api/v1/projects/${projectId}/academy/attachments/${a.id}/download`), resolve: true,
            name: fileName(a, `файл-${i + 1}`), mime: a.mime_type && a.mime_type.includes("/") ? a.mime_type : null,
            sizeBytes: num(a.file_size_bytes) },
  }));
  // 🔴 Порожній урок НЕ пропускаємо: у Sereda таких чотири, і мовчазна втрата читалась би як «урок зник».
  if (!out.length) push({ externalId: `${l.id}:empty`, title: l.title, kind: "text",
    content: desc ?? "Урок без вмісту — перенесено з Sereda порожнім." });
  return out;
}

/** Курс цілком. `api` дописує адресу Sereda до відносних посилань на файли. */
export function coursePlan(c: SerediaCourse, api: (path: string) => string, projectId: string): CoursePlan {
  const folders: FolderPlan[] = (c.modules ?? []).map((m, mi) => {
    let pos = 1;
    const materials: MaterialPlan[] = [];
    for (const l of (m.lessons ?? [])) { const ms = lessonMaterials(l, pos, api, projectId); pos += ms.length; materials.push(...ms); }
    return { externalId: m.id, title: m.title, position: m.sort_order ?? mi + 1, materials };
  });
  const hours = num(c.estimated_duration);
  const head = htmlToText(c.short_description ?? c.description ?? "");
  const description = [head, hours ? `Тривалість за програмою: ${hours} год.` : ""].filter(Boolean).join("\n\n") || null;
  return { externalId: c.id, title: c.title.replace(/\s+/g, " ").trim(), description, folders };
}

/** Куди лягає файл: інструмент качає з Sereda, гейт підкладає свою функцію — ядро про мережу не знає. */
export type SaveFile = (m: Extract<MaterialPlan, { kind: "file" }>) => Promise<{ storedName: string; size: number; skipped: boolean }>;
export interface ImportDb { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> }
export interface ImportCounts { courses: number; folders: number; materials: number; filesSaved: number; filesSkipped: number; bytes: number }

/**
 * Запис плану в дашборд: курс → папки → матеріали, усе за `external_id`, тому повторний прогін ОНОВЛЮЄ.
 * Курс приходить чернеткою з аудиторією «менеджер» — опублікований одразу потрапив би в знаменник навчання
 * кандидата й обвалив би його відсоток (рішення Романа 23.09.2026). Тримає #702.
 */
export async function importCourses(db: ImportDb, plans: CoursePlan[], actorId: number | null, saveFile: SaveFile): Promise<ImportCounts> {
  const c: ImportCounts = { courses: 0, folders: 0, materials: 0, filesSaved: 0, filesSkipped: 0, bytes: 0 };
  for (const p of plans) {
    const course = (await db.query<{ id: number }>(
      `INSERT INTO training_courses (title, description, audience, published, source, external_id, created_by)
       VALUES ($1, $2, 'manager', false, 'sereda', $3, $4)
       ON CONFLICT (external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description
       RETURNING id`, [p.title, p.description, p.externalId, actorId])).rows[0].id;
    for (const f of p.folders) {
      const folder = (await db.query<{ id: number }>(
        `INSERT INTO training_folders (name, position, course_id, external_id, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (external_id) WHERE external_id IS NOT NULL
           DO UPDATE SET name = EXCLUDED.name, position = EXCLUDED.position, course_id = EXCLUDED.course_id
         RETURNING id`, [f.title, f.position, course, f.externalId, actorId])).rows[0].id;
      for (const m of f.materials) {
        let stored: string | null = null, size: number | null = null, mime: string | null = null;
        if (m.kind === "file") {
          const d = await saveFile(m);
          stored = d.storedName; size = d.size; mime = m.file.mime;
          if (d.skipped) c.filesSkipped++; else { c.filesSaved++; c.bytes += d.size; }
        }
        await db.query(
          `INSERT INTO training_materials (folder_id, title, kind, url, stored_name, mime, size_bytes, content, position, required, external_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (external_id) WHERE external_id IS NOT NULL
             DO UPDATE SET folder_id = EXCLUDED.folder_id, title = EXCLUDED.title, kind = EXCLUDED.kind,
               url = EXCLUDED.url, stored_name = COALESCE(EXCLUDED.stored_name, training_materials.stored_name),
               mime = EXCLUDED.mime, size_bytes = EXCLUDED.size_bytes, content = EXCLUDED.content,
               position = EXCLUDED.position, required = EXCLUDED.required`,
          [folder, m.title, m.kind, m.kind === "video_embed" || m.kind === "link" ? m.url : null, stored, mime, size,
           m.kind === "text" ? m.content : m.content ?? null, m.position, m.required, m.externalId, actorId]);
        c.materials++;
      }
      c.folders++;
    }
    c.courses++;
  }
  return c;
}

export interface PlanTotals { courses: number; folders: number; materials: number; files: number; bytes: number; text: number; embeds: number }
export function totals(plans: CoursePlan[]): PlanTotals {
  const all = plans.flatMap((c) => c.folders.flatMap((f) => f.materials));
  return {
    courses: plans.length, folders: plans.reduce((a, c) => a + c.folders.length, 0), materials: all.length,
    files: all.filter((m) => m.kind === "file").length,
    bytes: all.reduce((a, m) => a + (m.kind === "file" ? m.file.sizeBytes ?? 0 : 0), 0),
    text: all.filter((m) => m.kind === "text").length,
    embeds: all.filter((m) => m.kind === "video_embed" || m.kind === "link").length,
  };
}
