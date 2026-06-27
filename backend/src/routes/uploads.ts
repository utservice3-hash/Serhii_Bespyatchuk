import { Router } from "express";
import { randomUUID } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { requireAuth } from "../auth/middleware.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

/** Accepts a base64 file payload, stores it on disk, returns its public URL. */
uploadsRouter.post("/", async (req, res) => {
  const { filename, dataBase64 } = req.body ?? {};
  if (!dataBase64 || typeof dataBase64 !== "string") {
    return res.status(400).json({ error: "Файл відсутній" });
  }
  const base64 = dataBase64.includes(",") ? dataBase64.split(",")[1] : dataBase64;
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > MAX_BYTES) {
    return res.status(413).json({ error: "Файл завеликий (макс. 15 МБ)" });
  }
  const ext = path.extname(String(filename ?? "")).slice(0, 10).replace(/[^.\w]/g, "");
  const name = `${randomUUID()}${ext}`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, name), buffer);
  res.json({ url: `/api/files/${name}`, name: filename ?? name });
});
