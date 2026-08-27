import json,re,sys
from collections import defaultdict, Counter

def parse(path):
    c=json.load(open(path))['fileContent']
    blocks=c.split('\n\n')
    out=[]
    for bi,b in enumerate(blocks):
        raw=[l for l in b.split('\n') if l.strip().startswith('|')]
        rows=[[x.strip() for x in l.strip().strip('|').split('|')] for l in raw]
        rows=[r for r in rows if not all(set(x)<=set(': -') for x in r)]
        ni=None
        for ri,r in enumerate(rows[:15]):
            txt=[x for x in r if x and 'merged' not in x and 'http' not in x]
            if any(re.match(r"^[А-ЯІЇЄҐ][а-яіїєґ']+\s+[А-ЯІЇЄҐ]",x) for x in txt):
                ni=ri; break
        if ni is None:
            out.append(dict(block=bi,recs=[]));continue
        names=rows[ni]
        colowner={}; checkof={}
        cur=None
        for ci,x in enumerate(names):
            if re.match(r"^[А-ЯІЇЄҐ][а-яіїєґ']+\s+[А-ЯІЇЄҐ]",x):
                colowner[ci]=re.sub(r'\s+',' ',x).strip(); cur=ci
            elif x.lower().startswith('перевірк') and cur is not None:
                checkof[cur]=ci
        recs=[]; curd=None
        for r in rows[ni+1:]:
            j=' '.join(r)
            m=re.findall(r'(\d{2}\.\d{2}(?:\.\d{4})?)',j)
            if m and 'http' not in j:
                curd=Counter(m).most_common(1)[0][0]; continue
            for ci,owner in colowner.items():
                if ci>=len(r): continue
                lk=re.findall(r'/leads/detail/(\d+)',r[ci])
                if not lk: continue
                chk=''
                cc=checkof.get(ci)
                if cc is not None and cc<len(r): chk=r[cc]
                recs.append(dict(date=curd,owner=owner,lead=lk[0],check=chk,has_check_col=cc is not None))
        out.append(dict(block=bi,recs=recs))
    return out

res=parse(sys.argv[1])
json.dump(res,open(sys.argv[2],'w'),ensure_ascii=False)
for r in res:
    if not r['recs']: continue
    ds=sorted({x['date'] for x in r['recs'] if x['date']})
    by=defaultdict(list)
    for x in r['recs']: by[x['owner']].append(x)
    print(f"--- block {r['block']} {ds[0] if ds else ''}..{ds[-1] if ds else ''} workdays={len(ds)}")
    for o,v in by.items():
        hc=[x for x in v if x['has_check_col']]
        filled=[x for x in hc if x['check'].strip() and x['check'].strip() not in ('\\-','-')]
        vals=Counter(x['check'].strip().lower() for x in hc if x['check'].strip())
        print(f"    {o:24s} n={len(v):4d} days={len({x['date'] for x in v}):3d} checkcol={len(hc):4d} filled={len(filled):4d} {dict(vals.most_common(8)) if vals else ''}")
