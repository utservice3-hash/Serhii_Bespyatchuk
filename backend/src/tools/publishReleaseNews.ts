/**
 * 📰 НОВИНА ПРО ВИКАТ — крок ланцюга, а не добра звичка.
 *
 * Читає верхній блок `RELEASE_NOTES.md` і кладе його у `news` категорії `company`.
 * Кличеться з ПРОД-чекауту (`cd <docroot>/backend && . ./.env && node dist/tools/…`) —
 * тим самим способом, що `migrate` і `markDeploy`: у стенді роль read-only, тож писати
 * звідти неможливо за побудовою, і це правильно.
 *
 * 🔴 ІДЕМПОТЕНТНІСТЬ ТРИМАЄ БАЗА, А НЕ КОД. `ON CONFLICT` по частковому унікальному
 * індексу `news_release_sha_uniq`: крок може впасти між вставкою й відповіддю, а ланцюг
 * перезапускають руками — перевірка «спершу подивись, чи вже є» програє цій гонці.
 *
 * 🔴 ТИША — ШТАТНИЙ РЕЗУЛЬТАТ. Немає непорожнього блоку → новини немає, вихід 0. Викат
 * без видимих для людей змін не повинен породжувати «оновлено»: така новина за тиждень
 * навчить не читати всі інші. Але причину тиші друкуємо вголос, і причини РІЗНІ:
 * «файла немає» — це наша пропажа, «блок порожній» — свідоме мовчання автора зміни.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pool } from "../db/pool.js";
import { parseReleaseNotes } from "../core/releaseNotes.js";

/** Файл лежить у корені репозиторію, а скрипт біжить із `backend/`. */
export const NOTES_PATH = resolve(import.meta.dirname, "..", "..", "..", "RELEASE_NOTES.md");

export const PUBLISH_SQL = `
  INSERT INTO news (category, title, body, author, release_sha)
  VALUES ('company', $1, $2, 'Дашборд', $3)
  ON CONFLICT (release_sha) WHERE release_sha IS NOT NULL DO NOTHING
  RETURNING id`;

function readNotes(): string | null {
  try { return readFileSync(NOTES_PATH, "utf8"); } catch { return null; }
}

export async function publishReleaseNews(sha: string): Promise<string> {
  const parsed = parseReleaseNotes(readNotes());
  if (parsed.note === null) {
    return parsed.reason === "no-file"
      ? `🔴 ${NOTES_PATH} не знайдено — новини не буде. Це НЕ штатна тиша: файл мав бути в репозиторії`
      : "тиша: у RELEASE_NOTES.md немає непорожнього верхнього блоку — цей викат нічого не оголошує (штатно)";
  }
  const r = await pool.query<{ id: number }>(PUBLISH_SQL, [parsed.note.title, parsed.note.body, sha]);
  return r.rowCount
    ? `опубліковано «${parsed.note.title}» (id ${r.rows[0].id})`
    : `новина про ${sha} вже існує — повторний прогін нічого не додав`;
}

if (process.argv[1]?.endsWith("publishReleaseNews.js")) {
  const sha = process.argv.find((a) => a.startsWith("--sha="))?.slice(6) ?? "";
  if (!sha) { console.error("🔴 --sha= обовʼязковий: без нього немає ідемпотентності"); process.exit(2); }
  publishReleaseNews(sha)
    .then((msg) => { console.log(msg); return pool.end(); })
    .catch((e) => { console.error(String(e)); process.exit(1); });
}
