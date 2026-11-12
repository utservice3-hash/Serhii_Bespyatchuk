import os,subprocess,time,resource,sys,glob
os.chdir(sys.argv[1]); out=open(sys.argv[2],"w")
files=sorted(glob.glob("dist/**/*.test.js",recursive=True))
for f in files:
    # окремий процес-обгортка на кожен файл, щоб ru_maxrss був саме його
    t=time.time()
    r=subprocess.run([sys.executable,"-c","import resource,subprocess,sys;subprocess.run(['nice','-n','20','node','--test-reporter=tap','--test',sys.argv[1]],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);print(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)",f],capture_output=True,text=True)
    rss=int(r.stdout.strip() or 0)//1048576  # macOS: bytes
    out.write(f"{f}\t{time.time()-t:.2f}\t{rss}\n"); out.flush()
out.write("DONE\n")
