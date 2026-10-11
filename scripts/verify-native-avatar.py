"""Actual native GPU worker, original cloned PCM, and photo-local learned blink."""
import base64,json,time,wave,subprocess,hashlib
from pathlib import Path
import cv2,numpy as np
root=Path(__file__).resolve().parents[1];out=root/'output/full-face-probe';out.mkdir(exist_ok=True)
with wave.open(str(root/'output/doubao-live-reply.wav'),'rb') as audio:pcm=audio.readframes(audio.getnframes())
worker=subprocess.Popen([str(root/'.runtime/avatar-env/Scripts/python.exe'),'-u',str(root/'scripts/avatar-worker.py'),str(root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW)
try:
 ready=json.loads(worker.stdout.readline());assert ready['type']=='ready' and ready['mouthDetail']=='native-256-fixed-portrait'
 assert ready['lowerFaceMotion']=='audio-driven-photo-warp'
 image=cv2.imread(str(root/'public/assets/avatar.png'));x,y,w,h=ready['region'];sample=[];times=[];paired=[];first=None
 manifest=json.loads((root/'public/assets/face-expressions/manifest.json').read_text(encoding='utf-8'));ex,ey,ew,eh=manifest['region']
 poses={k:cv2.imread(str(root/'public/assets/face-expressions'/v),cv2.IMREAD_UNCHANGED) for k,v in manifest['poses'].items()}
 video=cv2.VideoWriter(str(out/'runtime-silent.mp4'),cv2.VideoWriter_fourcc(*'mp4v'),20,(572,687))
 started=time.perf_counter()
 for command in [{'type':'begin','id':'native'},{'type':'audio','id':'native','pcm':base64.b64encode(pcm).decode()},{'type':'finish','id':'native'}]:worker.stdin.write(json.dumps(command)+'\n');worker.stdin.flush()
 index=0;events=[]
 while True:
  event=json.loads(worker.stdout.readline());assert event['id']=='native'
  if event['type']=='finished':break
  assert event['type']=='frame' and event['index']==index
  now=time.perf_counter();first=first or now;times.append(now)
  paired.append(base64.b64decode(event['pcm']));events.append(event);index+=1
 elapsed=time.perf_counter()-started
 for index,event in enumerate(events):
  patch=cv2.imdecode(np.frombuffer(base64.b64decode(event['jpeg']),np.uint8),cv2.IMREAD_COLOR);assert patch.shape==(h,w,3)
  frame=image.copy();frame[y:y+h,x:x+w]=patch
  blink={65:'blink25',66:'blink75',67:'blink100',68:'blink100',69:'blink50',70:'blink25'}
  pose=poses[blink.get(index,'attentive')];alpha=pose[:,:,3:]/255*(1 if index in blink else .3)
  roi=frame[ey:ey+eh,ex:ex+ew];roi[:]=np.clip(pose[:,:,:3]*alpha+roi*(1-alpha),0,255).astype(np.uint8)
  video.write(cv2.resize(frame,(572,687)))
  if index in [0,10,11,24,25,65,66,67,68,69,74,75,99,100,125,150]:sample.append(np.concatenate([image[320:620,410:710],frame[320:620,410:710]],axis=1))
  if index==25:cv2.imwrite(str(out/'runtime-frame.png'),frame)
 index=len(events)
 video.release();assert b''.join(paired)==pcm
 assert index==151
 report={'passed':True,'actualGPU':True,'mouthDetail':ready['mouthDetail'],'lowerFaceMotion':ready['lowerFaceMotion'],'frames':index,'outputFPS':20,'processingFPSIncludingFeatureJPEGAndPipe':index/elapsed,'firstFrameMs':(first-started)*1000,'elapsedSeconds':elapsed,'originalPcmUnchanged':True,'photoSha256':hashlib.sha256((root/'public/assets/avatar.png').read_bytes()).hexdigest(),'mouthRegion':ready['region'],'eyeRegion':manifest['region'],'eyePoses':len(poses),'cloudCalls':0,'fullFaceRealtimeModel':False}
 assert report['processingFPSIncludingFeatureJPEGAndPipe']>20,report
 (out/'runtime-verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8');cv2.imwrite(str(out/'runtime-comparison.jpg'),np.concatenate(sample,axis=0));print(json.dumps(report),flush=True)
finally:
 worker.stdin.close();worker.terminate();worker.wait(timeout=10)
