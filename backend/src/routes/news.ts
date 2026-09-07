import { Router } from "express";
import { isAdminScope, isAdminOrLead } from "../auth/rbac.js";
import { pool } from "../db/pool.js";
import { UNREAD_COUNT_SQL, MARK_SEEN_SQL } from "../core/newsSeen.js";
import { andAlive, DELETE_SQL } from "../core/newsVisibility.js";
import { requireAuth } from "../auth/middleware.js";

export const newsRouter = Router();
newsRouter.use(requireAuth);

const CATEGORIES = ["company", "logistics", "sales"];

/** Latest news, optionally filtered by category. */
newsRouter.get("/", async (req, res) => {
  const category = req.query.category as string | undefined;
  const params: unknown[] = [];
  let where = "";
  if (category && CATEGORIES.includes(category)) {
    params.push(category);
    where = `WHERE category = $1`;
  }
  const result = await pool.query(
    `SELECT id, category, title, body, author, image_url, created_at
     FROM news ${where} ${andAlive(where.length > 0)} ORDER BY created_at DESC LIMIT 100`,
    params
  );
  res.json({ news: result.rows });
});

newsRouter.post("/", async (req, res) => {
  if (!isAdminScope(req.auth!)) return res.status(403).json({ error: "Лише адміністратор" });
  const { category, title, body, imageUrl } = req.body ?? {};
  if (!CATEGORIES.includes(category) || !String(title ?? "").trim()) {
    return res.status(400).json({ error: "Категорія і заголовок обов'язкові" });
  }
  const author = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
    req.auth!.userId,
  ]);
  const result = await pool.query(
    `INSERT INTO news (category, title, body, author, image_url) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, category, title, body, author, image_url, created_at`,
    [category, String(title).trim(), body ?? null, author.rows[0]?.email ?? null, imageUrl ?? null]
  );
  res.json({ news: result.rows[0] });
});

newsRouter.delete("/:id", async (req, res) => {
  if (!isAdminScope(req.auth!)) return res.status(403).json({ error: "Лише адміністратор" });
  /* 🔴 МʼЯКО: рядок лишається, з видачі зникає. Фізичне видалення не лишало ні сліду,
     ні шляху назад — 07.09.2026 новина про викат зникла за годину, і єдиним доказом її
     існування була моя памʼять про id. Повторне видалення вже видаленої нічого не
     змінює (`AND deleted_at IS NULL`), тож дві вкладки не перезаписують одна одну. */
  const r = await pool.query(DELETE_SQL, [Number(req.params.id), req.auth!.userId]);
  res.json({ ok: true, removed: r.rowCount ?? 0 });
});

/** Today's approximate price per km by tonnage (latest available). */
/**
 * 🔔 СКІЛЬКИ НОВИН ЗʼЯВИЛОСЬ ПІСЛЯ МОГО ВІЗИТУ — окремим роутом, а не полем у списку.
 *
 * Значок у меню треба ще ДО того, як людина відкрила вкладку; вішати його на видачу
 * самого списку означало б, що лічильник зʼявляється лише там, де він уже не потрібен.
 */
newsRouter.get("/unread", async (req, res) => {
  const u = await pool.query<{ news_seen_at: Date | null }>(
    `SELECT news_seen_at FROM users WHERE id = $1`, [req.auth!.userId]);
  const r = await pool.query<{ n: number }>(UNREAD_COUNT_SQL, [u.rows[0]?.news_seen_at ?? null]);
  res.json({ unread: r.rows[0]?.n ?? 0 });
});

/** Відкрив вкладку — побачив. Час беремо СЕРВЕРНИЙ (див. `core/newsSeen.ts`). */
newsRouter.post("/seen", async (req, res) => {
  await pool.query(MARK_SEEN_SQL, [req.auth!.userId]);
  res.json({ ok: true });
});

newsRouter.get("/km-prices", async (_req, res) => {
  const result = await pool.query(
    `SELECT price_date, t20, t10, t5, t2 FROM km_prices ORDER BY price_date DESC LIMIT 1`
  );
  res.json({ prices: result.rows[0] ?? null });
});

newsRouter.put("/km-prices", async (req, res) => {
  if (!isAdminScope(req.auth!)) return res.status(403).json({ error: "Лише адміністратор" });
  const num = (v: unknown) => (v === "" || v == null ? null : Number(v));
  const { t20, t10, t5, t2 } = req.body ?? {};
  const result = await pool.query(
    `INSERT INTO km_prices (price_date, t20, t10, t5, t2, updated_at)
     VALUES (current_date, $1, $2, $3, $4, now())
     ON CONFLICT (price_date) DO UPDATE SET
       t20 = EXCLUDED.t20, t10 = EXCLUDED.t10, t5 = EXCLUDED.t5, t2 = EXCLUDED.t2, updated_at = now()
     RETURNING price_date, t20, t10, t5, t2`,
    [num(t20), num(t10), num(t5), num(t2)]
  );
  res.json({ prices: result.rows[0] });
});
