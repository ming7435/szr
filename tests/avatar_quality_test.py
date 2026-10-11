import sys,unittest
from pathlib import Path
import cv2,numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
try:
 from avatar_quality import MouthDetail
except ModuleNotFoundError:
 MouthDetail=None

class MouthDetailTests(unittest.TestCase):
 def setUp(self):
  self.assertIsNotNone(MouthDetail,'The local mouth detail/restoration stage is missing')
  yy,xx=np.mgrid[:360,:340]; self.face=np.stack([xx%256,yy%256,(xx+yy)%256],2).astype(np.uint8)
  self.points=np.array([[99,142],[230,129],[176,208],[123,277],[234,265]],np.float32)
  self.calls=[]
  def restore(aligned):
   self.calls.append(aligned.copy()); return aligned.copy()
  self.composer=MouthDetail(self.face,self.points,restore)
  self.low=cv2.resize(self.face,(96,96))
 def test_roi_preserves_photo_pixels_outside_mouth_and_reset_drops_detail(self):
  result=self.composer.render(self.low)
  x,y,w,h=self.composer.region
  self.assertEqual(result.shape,(h,w,3))
  composite=self.face.copy(); composite[y:y+h,x:x+w]=result
  self.assertTrue(np.array_equal(composite[:200],self.face[:200]),'Nose and eyes must retain original detail')
  self.composer.render(self.low); self.assertEqual(len(self.calls),1)
  self.composer.reset();self.composer.render(self.low);self.assertEqual(len(self.calls),2,'New replies must not reuse old mouth detail')
 def test_each_audio_driven_frame_changes_shape_between_detail_keyframes(self):
  low=np.full((96,96,3),130,np.uint8)
  for y in range(62,85):
   for x in range(28,69):
    if ((x-48)/19)**2+((y-73)/9)**2<1: low[y,x]=30+(x*11+y*9)%180
  self.composer.render(low)
  moved=cv2.warpAffine(low,np.array([[1,0,0],[0,1,3]],np.float32),(96,96),borderMode=cv2.BORDER_REPLICATE)
  second=self.composer.render(moved)
  self.assertEqual(len(self.calls),1,'Adjacent frames should preserve realtime speed')
  self.composer.reset(); reference=self.composer.render(low)
  self.assertGreater(np.mean(np.abs(second.astype(float)-reference.astype(float))),2,'The second frame must move with its current audio-driven mouth')
 def test_invalid_prediction_or_restore_does_not_emit_corrupt_mouth(self):
  with self.assertRaises(ValueError): self.composer.render(np.zeros((96,96,3),np.float32))
  broken=MouthDetail(self.face,self.points,lambda _:np.zeros((1,1,3),np.uint8))
  with self.assertRaises(ValueError): broken.render(self.low)

if __name__=='__main__':unittest.main()
