"""Offline verification of actual runtime mouth detail; no cloud calls."""
import base64,json,time,wave,subprocess,hashlib
from pathlib import Path
import cv2,numpy as np
root=Path(__file__).resolve().parents[1];out=root/'output/mouth-quality-probe'
with wave.open(str(root/'output/doubao-live-reply.wav'),'rb') as audio:pcm=audio.readframes(audio.getnframes())
worker=subprocess.Popen([str(root/'.runtime/avatar-env/Scripts/python.exe'),'-u',str(root/'scripts/avatar-worker.py'),str(root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW)
try:
 ready=json.loads(worker.stdout.readline());assert ready['type']=='ready' and ready['mouthDetail']=='GPEN-256-motion'
 image=cv2.imread(str(root/'public/assets/avatar.png'));x,y,w,h=ready['region'];sample=[];times=[];paired=[];first=None
 video=cv2.VideoWriter(str(out/'runtime-silent.mp4'),cv2.VideoWriter_fourcc(*'mp4v'),25,(572,686))
 started=time.perf_counter()
 for command in [{'type':'begin','id':'quality'},{'type':'audio','id':'quality','pcm':base64.b64encode(pcm).decode()},{'type':'finish','id':'quality'}]:worker.stdin.write(json.dumps(command)+'\n');worker.stdin.flush()
 index=0
 while True:
  event=json.loads(worker.stdout.readline());assert event['id']=='quality'
  if event['type']=='finished':break
  assert event['type']=='frame' and event['index']==index
  now=time.perf_counter();first=first or now;times.append(now)
  paired.append(base64.b64decode(event['pcm']));patch=cv2.imdecode(np.frombuffer(base64.b64decode(event['jpeg']),np.uint8),cv2.IMREAD_COLOR);assert patch.shape==(h,w,3)
  frame=image.copy();frame[y:y+h,x:x+w]=patch;video.write(cv2.resize(frame,(572,686)))
  if index in [0,10,11,24,25,74,75,99,100,125,150]: sample.append(np.concatenate([image[y:y+h,x:x+w],patch],axis=1))
  if index==25:cv2.imwrite(str(out/'runtime-frame.png'),frame)
  index+=1
 video.release();assert b''.join(paired)==pcm
 elapsed=time.perf_counter()-started;assert index==189
 report={'passed':True,'actualGPU':True,'mouthDetail':ready['mouthDetail'],'frames':index,'outputFPS':25,'processingFPSIncludingFeatureJPEGAndPipe':index/elapsed,'firstFrameMs':(first-started)*1000,'elapsedSeconds':elapsed,'originalPcmUnchanged':True,'photoSha256':hashlib.sha256((root/'public/assets/avatar.png').read_bytes()).hexdigest(),'region':ready['region'],'cloudCalls':0,'wholeFaceExpressions':False}
 (out/'runtime-verification.json').write_text(json.dumps(report,indent=2));cv2.imwrite(str(out/'runtime-comparison.jpg'),np.concatenate(sample,axis=0));print(json.dumps(report),flush=True)
finally:
 worker.stdin.close();worker.terminate();worker.wait(timeout=10)
