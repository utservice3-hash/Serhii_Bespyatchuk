import { Router } from "express";
import { pool } from "../db/pool.js";
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
    `SELECT id, category, title, body, author, created_at
     FROM news ${where} ORDER BY created_at DESC LIMIT 100`,
    params
  );
  res.json({ news: result.rows });
});

newsRouter.post("/", async (req, res) => {
  if (req.auth!.role !== "admin") return res.status(403).json({ error: "Лише адміністратор" });
  const { category, title, body } = req.body ?? {};
  if (!CATEGORIES.includes(category) || !String(title ?? "").trim()) {
    return res.status(400).json({ error: "Категорія і заголовок обов'язкові" });
  }
  const author = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
    req.auth!.userId,
  ]);
  const result = await pool.query(
    `INSERT INTO news (category, title, body, author) VALUES ($1, $2, $3, $4)
     RETURNING id, category, title, body, author, created_at`,
    [category, String(title).trim(), body ?? null, author.rows[0]?.email ?? null]
  );
  res.json({ news: result.rows[0] });
});

newsRouter.delete("/:id", async (req, res) => {
  if (req.auth!.role !== "admin") return res.status(403).json({ error: "Лише адміністратор" });
  await pool.query(`DELETE FROM news WHERE id = $1`, [Number(req.params.id)]);
  res.json({ ok: true });
});

/** Today's approximate price per km by tonnage (latest available). */
newsRouter.get("/km-prices", async (_req, res) => {
  const result = await pool.query(
    `SELECT price_date, t20, t10, t5, t2 FROM km_prices ORDER BY price_date DESC LIMIT 1`
  );
  res.json({ prices: result.rows[0] ?? null });
});

newsRouter.put("/km-prices", async (req, res) => {
  if (req.auth!.role !== "admin") return res.status(403).json({ error: "Лише адміністратор" });
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
