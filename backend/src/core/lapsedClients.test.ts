import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { lapsedFrom, prevMonthOf } from "./lapsedClients.js";

/**
 * #694 — «ВИПАВ» = гроші минулого місяця > 0 І цього місяця немає (або 0), по обидва боки межі:
 * купив в обох — не випав; купив лише цього — не випав; минулого 0 — не випав; сума за минулий
 * місяць складається з кількох бакетів; порядок — за сумою спадно. Січень бере грудень минулого року.
 */
test("#694 lapsedFrom: межі «купив минулого / не купив цього», сума, порядок; prevMonthOf через рік", () => {
  const rows = [
    { clientKey: "a", bucket: "2026-08-01", revenue: 500 }, { clientKey: "a", bucket: "2026-09-01", revenue: 100 },
    { clientKey: "b", bucket: "2026-08-01", revenue: 300 },
    { clientKey: "c", bucket: "2026-09-01", revenue: 900 },
    { clientKey: "d", bucket: "2026-08-01", revenue: 0 },
    { clientKey: "e", bucket: "2026-08-01", revenue: 200 }, { clientKey: "e", bucket: "2026-08-01", revenue: 250 }, { clientKey: "e", bucket: "2026-09-01", revenue: 0 },
    { clientKey: "f", bucket: "2026-07-01", revenue: 999 },
  ];
  assert.deepEqual(lapsedFrom(rows, "2026-08", "2026-09"), [{ clientKey: "e", prevRevenue: 450 }, { clientKey: "b", prevRevenue: 300 }]);
  assert.equal(prevMonthOf("2026-01"), "2025-12"); assert.equal(prevMonthOf("2026-09"), "2026-08");
});

/**
 * #694b — ПРОВОДКА: роут бере гроші з ядра (`successByClientBucket`), команду — через
 * `effectiveManagerSql`, а не з менеджера угоди; стоїть під вкладкою statistics; матриця знає
 * роут; фронт підписує, що поточний місяць не завершений.
 */
test("#694b /statistics/lapsed-clients: гроші з ядра, команда за ефективним менеджером, вкладка й матриця, чесний підпис", () => {
  const src = path.join(import.meta.dirname, "..", "..", "src");
  const r = readFileSync(path.join(src, "routes", "statisticsSeries.ts"), "utf8");
  const i = r.indexOf('statsSeriesRouter.get("/lapsed-clients"'); assert.ok(i > 0, "роут не знайдено");
  const body = r.slice(i, r.indexOf("\n});", i));
  assert.match(body, /money\.successByClientBucket\(/, "гроші не з ядра");
  assert.match(body, /\blapsedFrom\(/);
  assert.match(body, /\bclientOwnersFor\(keys, thisYm\)/, "команда не з ядра clientOwnersFor");
  assert.doesNotMatch(body, /SUM\(d?\.?price\)|FROM deals/, "власний SQL у роуті");
  const owner = readFileSync(path.join(src, "core", "clientOwner.ts"), "utf8");
  assert.match(owner, /psm\.funnel_stage = 'paid'/, "привʼязка мусить іти по ОПЛАЧЕНИХ угодах (інакше 114 клієнтів лягають на бухгалтерію)");
  assert.match(owner, /LEFT JOIN managers mm ON mm\.id = \$\{effectiveManagerSql\("lo", "pm", month\)\}/, "JOIN менеджера мусить іти через закріплення, а не pm.manager_id");
  assert.match(readFileSync(path.join(src, "auth", "routeTab.ts"), "utf8"), /pre\("\/api\/statistics\/lapsed-clients"\), tabs: \["statistics"\]/);
  assert.match(readFileSync(path.join(src, "auth", "accessMatrix.ts"), "utf8"), /path: "\/api\/statistics\/lapsed-clients\?month=2026-09"/);
  const f = readFileSync(path.join(src, "..", "..", "frontend", "src", "pages", "dashboard", "sections", "StatisticsChartsSection.tsx"), "utf8");
  assert.match(f, /не завершен/, "підпис про незавершений місяць");
  assert.match(f, /fetchLapsedClients\(/);
});
