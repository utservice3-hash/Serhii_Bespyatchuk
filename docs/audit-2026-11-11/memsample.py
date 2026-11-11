#!/usr/bin/python3
"""Пасивний семплер памʼяті акаунта (аудит тестів 11.11.2026). Лише читає /proc; нічого не вбиває.
Пише CSV: час UTC; сума PSS МБ (спільні сторінки поділено між процесами); за категоріями; кількість процесів; і події «зник процес прода»."""
import os, sys, time
dur = float(sys.argv[1]); out = sys.argv[2]; uid = os.getuid(); page = os.sysconf("SC_PAGE_SIZE")
cats = ["prod","test","tsc","vite","build","npm","php","othernode","other"]
cache = {}
def cat(pid):
    if pid in cache: return cache[pid]
    try: a = open(f"/proc/{pid}/cmdline","rb").read().replace(b"\0",b" ").decode("utf8","replace")
    except Exception: return None
    if "dist/index.js" in a and "node" in a: c="prod"
    elif "--test" in a or ".test.js" in a: c="test"
    elif "/tsc" in a or "tsc " in a or "typescript/bin" in a: c="tsc"
    elif "vite" in a: c="vite"
    elif "transpileBuild" in a or "copyAssets" in a or "deploy.js" in a: c="build"
    elif a.startswith("npm") or "/npm" in a: c="npm"
    elif "php" in a or "WorkerMan" in a: c="php"
    elif "node" in a: c="othernode"
    else: c="other"
    cache[pid]=c; return c
t0=time.time(); last=None; prodpid=None; peak=0
with open(out,"w") as f:
    f.write("utc,total_mb,"+",".join(cats)+",nproc,ntest,event\n")
    while time.time()-t0<dur:
        s={c:0 for c in cats}; n=0; nt=0; pids=[]
        for d in os.listdir("/proc"):
            if not d.isdigit(): continue
            try:
                if os.stat(f"/proc/{d}").st_uid!=uid: continue
                sm=open(f"/proc/{d}/smaps_rollup").read(); rss=int(sm[sm.index("Pss:")+4:].split()[0])/1024
            except Exception: continue
            c=cat(int(d)); 
            if c is None: continue
            s[c]+=rss; n+=1; pids.append(int(d))
            if c=="test": nt+=1
            if c=="prod" and rss>100: cur=int(d)
        for p in list(cache):
            if p not in pids: cache.pop(p,None)
        ev=""
        cp=[p for p in pids if cache.get(p)=="prod"]
        big=max(cp,key=lambda p:0) if cp else None
        pp=cp[0] if cp else None
        if prodpid is not None and prodpid not in pids: ev="PROD_GONE_%d"%prodpid
        prodpid = (cp[-1] if cp else None)
        tot=sum(s.values()); peak=max(peak,tot)
        row=(round(tot),)+tuple(round(s[c]) for c in cats)+(n,nt)
        if row!=last or ev:
            f.write(time.strftime("%H:%M:%S",time.gmtime())+"."+str(int(time.time()%1*10))+","+",".join(map(str,row))+","+ev+"\n"); f.flush(); last=row
        time.sleep(0.5)
    f.write("# peak_total_mb,%d\n"%peak)
