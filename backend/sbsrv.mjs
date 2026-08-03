// 🔒 ПІСОЧНИЦЯ: окремий процес, ЛИШЕ dashboard-роутер, БЕЗ джоб і крону,
// зʼєднання під роллю test_readonly — запис у прод неможливий за побудовою.

const express = (await import("express")).default;
const jwt = (await import("jsonwebtoken")).default;
const { dashboardRouter } = await import("/home/user/Serhii_Bespyatchuk/backend/dist/routes/dashboard.js");
const { requireAuth } = await import("/home/user/Serhii_Bespyatchuk/backend/dist/auth/middleware.js");
const rbac = await import("/home/user/Serhii_Bespyatchuk/backend/dist/auth/rbac.js");
if (rbac.refreshRoles) await rbac.refreshRoles();
const app = express();
app.use(express.json());
app.use("/api/dashboard", requireAuth, dashboardRouter);
app.use((err, _req, res, _next) => { console.error("ERR:", err && (err.stack||err.message||err)); res.status(500).json({ error: String(err) }); });
process.on("uncaughtException", (e) => console.error("UNCAUGHT:", e && (e.stack||e)));
process.on("unhandledRejection", (e) => console.error("UNHANDLED:", e && (e.stack||e)));
app.listen(3999, "127.0.0.1", () => console.log("sandbox on 3999"));
