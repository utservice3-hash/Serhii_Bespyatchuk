#!/usr/bin/python3
"""Аудит 11.11.2026: запускає команду, міряє пік RSS її дерева і всього акаунта (/proc кожні 0,2 с).
ЗАПОБІЖНИК: якщо сума RSS акаунта > --kill-above МБ — дерево команди отримує SIGKILL (щоб не впав прод).
Також фіксує, чи змінився PID прода за час прогону (= аварія прода)."""
import os, sys, time, json, signal, subprocess
a = sys.argv[1:]; sep = a.index("--"); opts = dict(x[2:].split("=", 1) for x in a[:sep]); cmd = a[sep + 1:]
kill_above = float(opts.get("kill-above", "1500")); log = opts.get("log", "/dev/null"); cwd = opts.get("cwd", ".")
uid = os.getuid(); page = os.sysconf("SC_PAGE_SIZE")
def snap():
    procs = {}
    for d in os.listdir("/proc"):
        if not d.isdigit(): continue
        try:
            if os.stat("/proc/" + d).st_uid != uid: continue
            st = open(f"/proc/{d}/stat").read(); ppid = int(st[st.rindex(")") + 2:].split()[1])
            rss = int(open(f"/proc/{d}/statm").read().split()[1]) * page / 1048576
            cl = open(f"/proc/{d}/cmdline", "rb").read()
        except Exception: continue
        procs[int(d)] = (ppid, rss, cl)
    return procs
def prodpid(p):
    for k, (pp, r, cl) in p.items():
        if b"dist/index.js" in cl and cl.startswith(b"node"): return k
p0 = snap(); prod0 = prodpid(p0); base_total = sum(v[1] for v in p0.values())
t0 = time.time()
with open(log, "w") as lf:
    ch = subprocess.Popen(cmd, cwd=cwd, stdout=lf, stderr=subprocess.STDOUT, start_new_session=True)
peak_tree = peak_total = 0; peak_n = 0; killed = False; prod_events = []; last_prod = prod0; timeline = []
while ch.poll() is None:
    p = snap(); total = sum(v[1] for v in p.values())
    kids = {}
    for k, (pp, r, cl) in p.items(): kids.setdefault(pp, []).append(k)
    st = [ch.pid]; tree = 0; n = 0
    while st:
        x = st.pop()
        if x in p: tree += p[x][1]; n += 1
        st.extend(kids.get(x, []))
    pr = prodpid(p)
    if pr != last_prod: prod_events.append({"t": round(time.time() - t0, 1), "from": last_prod, "to": pr, "total_mb": round(total)}); last_prod = pr
    peak_tree = max(peak_tree, tree); peak_total = max(peak_total, total); peak_n = max(peak_n, n)
    timeline.append((round(time.time() - t0, 1), round(total), round(tree), n))
    if total > kill_above and not killed:
        killed = True
        try: os.killpg(ch.pid, signal.SIGKILL)
        except Exception: pass
    time.sleep(0.2)
print(json.dumps({"cmd": " ".join(cmd)[:160], "wall_s": round(time.time() - t0, 1), "code": ch.returncode,
  "base_total_mb": round(base_total), "peak_total_mb": round(peak_total), "peak_tree_mb": round(peak_tree), "peak_procs": peak_n,
  "killed_by_guard": killed, "prod_pid_changes": prod_events,
  "p90_total_mb": sorted(x[1] for x in timeline)[int(len(timeline) * .9)] if timeline else None}))
with open(log + ".timeline.csv", "w") as tf:
    tf.write("t_s,total_mb,tree_mb,procs\n"); tf.writelines(f"{a},{b},{c},{d}\n" for a, b, c, d in timeline)
