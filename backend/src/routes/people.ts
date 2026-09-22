import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { listPeoplePhotos, photoFileOf, applyPhotoAction, PeopleError } from "../core/people.js";
import { checkPhoto, photoStoredName, photoDir } from "../core/peopleRules.js";

/**
 * 📷 ФОТО СПІВРОБІТНИКІВ (22.09.2026). Дві межі:
 *  · САМЕ ФОТО (`GET /photo/:employeeId`) — будь-кому залогіненому: воно на слайдах зустрічі, у
 *    номінаціях і (далі) на дошці пошани, яку бачать усі ролі. Вкладки немає свідомо — запис у
 *    `ROUTE_BOUNDARY_EXEMPTIONS`;
 *  · СПИСОК і ЗАПИС — право сейфу `view_employee_secrets` (admin, ceo, opdir, kvp, hr): ті самі люди,
 *    що ведуть «Найм → Співробітники», де й живе кнопка «Фото».
 * Файли — у КОРЕНІ теки документів з префіксом `photo-`: під нічним бекапом, поза публічною текою.
 */
export const peopleRouter = Router();
peopleRouter.use(requireAuth);

/** Корінь теки документів — під нічним бекапом (`photoDir`, #641). */
const DOCS_DIR = photoDir();
/** id співробітника — додатне ціле в межах `integer` Postgres; інакше 400 ще до БД і до запису файла. */
const idOf = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) throw new PeopleError(400, "невірний id співробітника");
  return n;
};
const safe = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req, res).catch((e: unknown) => {
    if (e instanceof PeopleError) { if (!res.headersSent) res.status(e.status).json({ error: e.message }); return; }
    console.error("people:", e);
    if (!res.headersSent) res.status(500).json({ error: "Не вдалося обробити фото — спробуйте ще раз" });
  });
};
const b64 = (v: unknown) => (typeof v === "string" && v ? Buffer.from(v.includes(",") ? v.split(",")[1] : v, "base64") : null);

peopleRouter.get("/photo/:employeeId", safe(async (req, res) => {
  // 🎓 Кандидат (зовнішній стажист) бачить лише «Навчання» й «Документи» — фото персоналу йому не належать,
  // і жодного екрана з фото в нього немає. Роут без вкладки, тож межу ставимо тут (#644).
  res.setHeader("Cache-Control", "no-store"); // відмови й 404 не кешуються; успіх перепише заголовок нижче
  if (req.auth!.roleKey === "candidate") return res.status(403).json({ error: "Фото співробітників — для команди" });
  const file = await photoFileOf(idOf(req.params.employeeId));
  if (!file) return res.status(404).json({ error: "Фото немає" });
  // Імʼя файлу — лише з бази (`photo-<uuid>.ext`), ніколи з запиту; basename — друга лінія проти `..`.
  // Кеш на добу — лише разом з успішною віддачею файла (`headers` send ставить на самій віддачі).
  res.sendFile(path.join(DOCS_DIR, path.basename(file)), { headers: { "Cache-Control": "private, max-age=86400" } }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Файл фото на диску не знайдено" });
  });
}));

peopleRouter.get("/photos", requirePerm("view_employee_secrets"), safe(async (_req, res) => {
  res.json({ people: await listPeoplePhotos() });
}));

peopleRouter.post("/photo/:employeeId", requirePerm("view_employee_secrets"), safe(async (req, res) => {
  const id = idOf(req.params.employeeId);
  const buf = b64(req.body?.dataBase64);
  const chk = checkPhoto(buf);
  if (!chk.ok) return res.status(400).json({ error: chk.error });
  const stored = photoStoredName(randomUUID(), chk.mime);
  await mkdir(DOCS_DIR, { recursive: true });
  await writeFile(path.join(DOCS_DIR, stored), buf!);
  try {
    res.status(201).json(await applyPhotoAction(id, { kind: "upload", file: stored }, req.auth!.userId));
  } catch (e) {
    // Відмова (немає людини, звільнений) — щойно записаний файл нікому не належить: прибираємо лише його.
    await unlink(path.join(DOCS_DIR, stored)).catch(() => undefined);
    throw e;
  }
}));

peopleRouter.delete("/photo/:employeeId", requirePerm("view_employee_secrets"), safe(async (req, res) => {
  res.json(await applyPhotoAction(idOf(req.params.employeeId), { kind: "remove" }, req.auth!.userId));
}));

peopleRouter.post("/photo/:employeeId/restore", requirePerm("view_employee_secrets"), safe(async (req, res) => {
  res.json(await applyPhotoAction(idOf(req.params.employeeId), { kind: "restore" }, req.auth!.userId));
}));
