import sys,unittest,json,hashlib,tempfile
from pathlib import Path
import cv2,numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
try:
 from avatar_native import NativeMouth, verify_portrait_model
 import avatar_native
 batch_mels=getattr(avatar_native,'batch_mels',None)
except ModuleNotFoundError:
 NativeMouth=verify_portrait_model=batch_mels=None
from avatar_features import AudioFrames

class NativeMouthTests(unittest.TestCase):
 def setUp(self):
  self.assertIsNotNone(NativeMouth,'Native 256px mouth composition missing')
  yy,xx=np.mgrid[:360,:340];self.face=np.stack([xx%256,yy%256,(xx+yy)%256],2).astype(np.uint8)
  self.points=np.array([[99,142],[230,129],[176,208],[123,277],[234,265]],np.float32)
  self.mouth=NativeMouth(self.face,self.points)
 def test_native_texture_follows_each_audio_frame_and_leaves_eyes_unchanged(self):
  low=np.full((256,256,3),.5,np.float32)
  cv2.ellipse(low,(132,195),(39,12),0,0,360,(.12,.12,.12),-1)
  a=self.mouth.render(low.transpose(2,0,1)[None])
  cv2.ellipse(low,(132,195),(39,24),0,0,360,(.05,.05,.05),-1)
  b=self.mouth.render(low.transpose(2,0,1)[None])
  self.assertGreater(np.mean(np.abs(a.astype(float)-b.astype(float))),3)
  x,y,w,h=self.mouth.region;composite=self.face.copy();composite[y:y+h,x:x+w]=b
  self.assertTrue(np.array_equal(composite[:200],self.face[:200]))
  self.assertEqual(b.shape,(h,w,3))
 def test_invalid_native_prediction_is_rejected(self):
  for shape in [(1,3,96,96),(3,256,256)]:
   with self.assertRaises(ValueError):self.mouth.render(np.zeros(shape,np.float32))
  with self.assertRaises(ValueError):self.mouth.render(np.full((1,3,256,256),np.nan,np.float32))
 def test_lower_face_follows_current_generated_shape_without_changing_eyes_or_photo_texture(self):
  self.assertTrue(hasattr(NativeMouth,'set_reference'),'Audio-driven lower-face motion is missing')
  yy,xx=np.mgrid[:360,:340]
  texture=((xx//7+yy//7)%2*120+70).astype(np.uint8)
  face=np.stack([texture,texture,texture],2)
  detail=NativeMouth(face,self.points,lower_face=True)
  reference=cv2.resize(face,(256,256)).astype(np.float32).transpose(2,0,1)[None]/255
  detail.set_reference(reference)
  still=detail.render(reference)
  shifted=cv2.warpAffine(reference[0].transpose(1,2,0),np.float32([[1,0,4],[0,1,0]]),(256,256),borderMode=cv2.BORDER_REFLECT_101)
  moving=detail.render(shifted.transpose(2,0,1)[None])
  x,y,w,h=detail.region;composite=face.copy();composite[y:y+h,x:x+w]=moving
  self.assertTrue(np.array_equal(composite[:200],face[:200]),'Eye and brow pixels must stay original')
  still_face=face.copy();still_face[y:y+h,x:x+w]=still
  self.assertGreater(np.mean(np.abs(composite[235:295,45:75].astype(float)-still_face[235:295,45:75].astype(float))),5,'Cheek outside the old mouth patch must move')
  self.assertTrue(np.array_equal(still_face[235:295,45:75],face[235:295,45:75]),'Still cheeks must preserve photo texture exactly')
  detail.reset();again=detail.render(reference)
  self.assertTrue(np.array_equal(again,still),'A previous mouth shape cannot persist after reset')
 def test_lower_face_requires_a_valid_reference_before_rendering(self):
  self.assertTrue(hasattr(NativeMouth,'set_reference'),'Lower-face reference validation is missing')
  detail=NativeMouth(self.face,self.points,lower_face=True)
  with self.assertRaises(ValueError):detail.render(np.zeros((1,3,256,256),np.float32))
  for invalid in [np.zeros((1,3,96,96),np.float32),np.full((1,3,256,256),np.nan,np.float32)]:
   with self.assertRaises(ValueError):detail.set_reference(invalid)
 def test_still_photographic_reference_does_not_create_spurious_cheek_motion(self):
  photo=cv2.imread(str(Path(__file__).resolve().parents[1]/'public/assets/avatar.png'))
  face=photo[268:628,388:728].copy()
  detail=NativeMouth(face,self.points,lower_face=True)
  reference=cv2.resize(face,(256,256)).astype(np.float32).transpose(2,0,1)[None]/255
  detail.set_reference(reference)
  x,y,w,h=detail.region;composite=face.copy();composite[y:y+h,x:x+w]=detail.render(reference)
  old=NativeMouth(face,self.points);mx,my,mw,mh=old.region
  outside=np.ones(face.shape[:2],bool);outside[my:my+mh,mx:mx+mw]=False
  self.assertTrue(np.array_equal(composite[outside],face[outside]),'Still photo texture must not jitter in low-contrast skin')
 def test_cached_portrait_and_model_integrity_reject_different_photo_or_weights(self):
  self.assertIsNotNone(verify_portrait_model)
  with tempfile.TemporaryDirectory() as folder:
   folder=Path(folder);photo=b'fixed portrait';(folder/'native.xml').write_bytes(b'XML');(folder/'native.bin').write_bytes(b'weights')
   spec={'photoSHA256':hashlib.sha256(photo).hexdigest(),'region':[388,268,340,360],'nativeSize':256,'files':{name:hashlib.sha256((folder/name).read_bytes()).hexdigest() for name in ['native.xml','native.bin']}}
   (folder/'native-source.json').write_text(json.dumps(spec),encoding='utf-8')
   self.assertEqual(verify_portrait_model(folder,photo)['nativeSize'],256)
   with self.assertRaises(ValueError):verify_portrait_model(folder,b'different portrait')
   (folder/'native.bin').write_bytes(b'different weights')
   with self.assertRaises(ValueError):verify_portrait_model(folder,photo)

class NativeTimingTests(unittest.TestCase):
 def test_batch_keeps_distinct_current_audio_and_padding_cannot_duplicate_tail_audio(self):
  pcm=np.arange(2500,dtype=np.int16).tobytes();stream=AudioFrames(fps=20);stream.push(pcm);frames=list(stream.pop_ready(finish=True))
  self.assertIsNotNone(batch_mels,'Native batching is missing')
  pair=batch_mels(frames[:2]);self.assertEqual(pair.shape,(2,1,80,16))
  self.assertTrue(np.array_equal(pair[0:1],frames[0].mel));self.assertTrue(np.array_equal(pair[1:2],frames[1].mel))
  tail=batch_mels(frames[2:]);self.assertTrue(np.array_equal(tail[0],tail[1]))
  self.assertEqual(len(frames[2].pcm),200,'Only the real short tail is emitted')
  with self.assertRaises(ValueError):batch_mels([])
  with self.assertRaises(ValueError):batch_mels(frames)
 def test_20fps_uses_current_50ms_pcm_without_dropping_partial_tail(self):
  pcm=np.arange(24000*2+123,dtype=np.int16).tobytes()
  stream=AudioFrames(fps=20)
  for at in range(0,len(pcm),2468):stream.push(pcm[at:at+2468])
  frames=list(stream.pop_ready(finish=True))
  self.assertEqual(len(frames),41)
  self.assertEqual(b''.join(frame.pcm for frame in frames),pcm)
  self.assertTrue(all(len(frame.pcm)==2400 for frame in frames[:-1]))
  self.assertTrue(all(frame.mel.shape==(1,1,80,16) for frame in frames))
  # Same physical audio moment must use the same mel window at either rate.
  reference=AudioFrames();reference.push(pcm);base=list(reference.pop_ready(finish=True))
  self.assertTrue(np.allclose(frames[4].mel,base[5].mel))

if __name__=='__main__':unittest.main()
