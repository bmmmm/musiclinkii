import cv2, time, json, numpy as np
print(cv2.__version__)
B='/private/tmp/claude-501/-Users-bma-offline-coding-musiclinkii/b199e6f2-b49a-44be-8352-6bdebd2fce96/scratchpad/verify/'
d=json.load(open(B+'index.json'))
r=d['rows'][0]
o=cv2.imread(B+r['original'],cv2.IMREAD_GRAYSCALE)
q=cv2.imread(B+r['hard'],cv2.IMREAD_GRAYSCALE)
cv2.setNumThreads(1)
dets={'ORB500':cv2.ORB_create(nfeatures=500),'ORB1500':cv2.ORB_create(nfeatures=1500),'AKAZE':cv2.AKAZE_create(),'SIFT':cv2.SIFT_create()}
for n,det in dets.items():
    t=time.perf_counter(); k1,d1=det.detectAndCompute(o,None); t1=time.perf_counter()-t
    t=time.perf_counter(); k2,d2=det.detectAndCompute(q,None); t2=time.perf_counter()-t
    norm=cv2.NORM_L2 if n=='SIFT' else cv2.NORM_HAMMING
    bf=cv2.BFMatcher(norm)
    t=time.perf_counter(); m=bf.knnMatch(d2,d1,k=2); tm=time.perf_counter()-t
    good=[a for a,b in m if a.distance<0.75*b.distance]
    print(n,'kp',len(k1),len(k2),'det %.1f/%.1fms'%(t1*1e3,t2*1e3),'match %.1fms'%(tm*1e3),'good',len(good))
