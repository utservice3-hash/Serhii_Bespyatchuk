// Запускає команду й міряє пік СУМИ RSS усього дерева процесів (ps кожні 200 мс) + стінний час.
// Опційно: --kill-above=МБ — вбиває дерево, якщо СУМА RSS усіх процесів користувача перевищила поріг (запобіжник для хостингу).
// Вивід: JSON-рядок у stdout, повний вивід команди — у файл --log.
import { spawn, execFileSync } from "node:child_process";
import { openSync } from "node:fs";
const args = process.argv.slice(2);
const opt = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : undefined; };
const sep = args.indexOf("--");
const cmd = args.slice(sep + 1);
const log = opt("log") ?? "/dev/null";
const killAbove = Number(opt("kill-above") ?? 0);
const user = process.env.USER ?? "";
const fd = openSync(log, "w");
const t0 = Date.now();
const child = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", fd, fd], detached: true, env: process.env });
let peakTree = 0, peakProcs = 0, peakUser = 0, killed = false, samples = 0;
const sample = () => {
  let out;
  try { out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,user="], { encoding: "utf8", maxBuffer: 1 << 24 }); } catch { return; }
  const kids = new Map(); const rss = new Map(); let userSum = 0;
  for (const l of out.split("\n")) {
    const p = l.trim().split(/\s+/); if (p.length < 4) continue;
    const pid = +p[0], ppid = +p[1], r = +p[2];
    rss.set(pid, r); if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid);
    if (p[3] === user) userSum += r;
  }
  let sum = 0, n = 0; const st = [child.pid];
  while (st.length) { const p = st.pop(); if (!rss.has(p)) continue; sum += rss.get(p); n++; for (const k of kids.get(p) ?? []) st.push(k); }
  samples++;
  peakTree = Math.max(peakTree, sum); peakProcs = Math.max(peakProcs, n); peakUser = Math.max(peakUser, userSum);
  if (killAbove && userSum / 1024 > killAbove && !killed) { killed = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }
};
const iv = setInterval(sample, 200);
child.on("exit", (code, sig) => {
  clearInterval(iv);
  console.log(JSON.stringify({ cmd: cmd.join(" ").slice(0, 200), wall_s: +((Date.now() - t0) / 1000).toFixed(1), code, sig,
    peak_tree_mb: Math.round(peakTree / 1024), peak_procs: peakProcs, peak_user_mb: Math.round(peakUser / 1024), killed_by_guard: killed, samples }));
});
