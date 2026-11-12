import json,sys,datetime as dt,collections
SP=sys.argv[1]
boots=[]
for l in open(SP+'/app_boot_45d.txt'):
    p=l.split()
    if len(p)>=4 and p[0][:2].isdigit() and '-' in p[0] and p[3] in('crash','deploy','first','deploy-intent'):
        t=dt.datetime.strptime('2026-'+p[0]+' '+p[1],'%Y-%m-%d %H:%M:%S')  # Kyiv local (EET/EEST)
        boots.append((t,p[2],p[3]))
# Kyiv offset: EEST (+3) until 2026-10-25 03:00, then EET (+2)
def toutc(t): return t-dt.timedelta(hours=3 if t<dt.datetime(2026,10,25,4) else 2)
wins=[];open_={}
for l in open(SP+'/lock_journal.jsonl'):
    e=json.loads(l); at=dt.datetime.strptime(e['at'][:19],'%Y-%m-%dT%H:%M:%S')
    if e['kind']=='take': open_=(at,e['who'],e['reason'])
    elif e['kind']=='release' and open_:
        wins.append((open_[0],at,open_[1],open_[2],e['reason'])); open_={}
crashes=[b for b in boots if b[2]=='crash']
print('усього стартів',len(boots),'з них crash',len(crashes),'період',boots[0][0].date(),'..',boots[-1][0].date())
cats=collections.Counter(); rows=[]
for t,_,_ in crashes:
    u=toutc(t)
    nxt=[b for b in boots if b[0]>t]
    gap=(nxt[0][0]-t).total_seconds()/60 if nxt else None
    nk=nxt[0][2] if nxt else ''
    w=[x for x in wins if x[0]<=u<=x[1]]
    if w:
        into=(u-w[0][0]).total_seconds()
        rel=w[0][4]
        if gap is not None and gap<=3 and nk=='deploy': c='A: фаза check свого/чужого викату (до kill ≤3 хв)'
        elif 'check' in rel or 'Killed' in rel or 'tsc' in rel: c='B: під замком, check упав'
        else: c='C: під замком після kill — приймання/матриця'
    else:
        into=None
        c='D: поза замком, 03:55-04:20' if t.hour==4 or (t.hour==3 and t.minute>50) else 'E: поза замком, інше'
    cats[c]+=1; rows.append((t,c,into,gap,w[0][2] if w else ''))
for k,v in sorted(cats.items()): print(f'{v:4d}  {k}')
print()
for t,c,into,gap,who in rows[-40:]:
    print(t, c[:2], 'від take %ss'%int(into) if into is not None else '', 'до наст.старту %.0f хв'%gap if gap is not None else '', who)
print('\n--- E/D/B/C детально')
for t,c,into,gap,who in rows:
    if c[0] in 'EDBC': print(t, c[:2], 'take+%ss'%int(into) if into is not None else '', 'наст.старт +%.0f хв'%gap if gap is not None else '', who)
print('\n--- по тижнях: crash / усього стартів')
wk=collections.Counter(); wkc=collections.Counter(); wka=collections.Counter()
for t,_,k in boots: wk[t.strftime('%m-%d')[:5] if False else t.isocalendar()[1]]+=1
for t,c,*_ in rows:
    wkc[t.isocalendar()[1]]+=1
    if c[0]=='A': wka[t.isocalendar()[1]]+=1
for w in sorted(wk): print('тиждень',w,'стартів',wk[w],'crash',wkc[w],'з них A',wka[w])
print('\n--- A по днях, і take+сек')
d=collections.defaultdict(list)
for t,c,into,gap,who in rows:
    if c[0]=='A': d[t.date()].append(int(into))
for k in sorted(d): print(k, len(d[k]), sorted(d[k]))
# deploys per day with check phase (lock takes)
tk=collections.Counter()
for w in wins: tk[(w[0]+dt.timedelta(hours=2)).date()]+=1
print('\n--- взяття замка по днях (жовт-лист)')
for k in sorted(tk):
    if k>=dt.date(2026,10,20): print(k, tk[k], 'A-аварій', len(d.get(k,[])))
print('\n--- під замком: за відстанню від take')
b=collections.Counter(); late=[]
for t,c,into,gap,who in rows:
    if into is None: continue
    if into<=300: b['≤300 с (фаза check)']+=1
    else: b['>300 с (run/приймання/матриця)']+=1; late.append((str(t),int(into),who))
print(dict(b)); print(late)
