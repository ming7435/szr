import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer } from '../server.mjs';
import { DoubaoService } from '../doubao-service.mjs';
import { encodeFrame, decodeFrame } from '../doubao-protocol.mjs';

const parent=path.resolve('output');
const fakeEncryption={id:'test-only',encrypt:async text=>Buffer.from(text),decrypt:async bytes=>bytes.toString()};
async function setup(t,options={}) {
  const root=await mkdtemp(path.join(parent,'guide-test-'));
  const server=createServer({dataRoot:root,config:{apiKey:null},localVoice:{publicStatus:async()=>({available:false}),close(){}},localAvatar:{attach(){},close(){},publicConfig:()=>({enabled:false})},...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));assert.ok(root.startsWith(parent+path.sep));await rm(root,{recursive:true,force:true});});
  const post=body=>fetch(base+'/api/guide',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  return {root,server,base,post};
}

test('guide API defaults to the real Chengde resort within one tourism entry',async t=>{
  const {base}=await setup(t);
  const response=await fetch(base+'/api/guide');assert.equal(response.status,200);
  const guide=await response.json();
  assert.equal(guide.selectedScene,'scenic');
  assert.deepEqual(guide.scenes.map(s=>s.id),['scenic']);
  assert.equal(guide.scenes[0].label,'旅游景区');
  assert.ok(guide.scenes.every(scene=>scene.role==='景区讲解员'));
  for(const id of ['scenic']) {
    const profile=guide.profiles[id];assert.equal(profile.demo,false);assert.equal(profile.venue,'承德避暑山庄');
    assert.ok(profile.overview.includes('1703')&&profile.overview.includes('1792')&&profile.overview.includes('1994'));
    assert.ok(profile.highlights.includes('烟雨楼')&&profile.route.includes('丽正门'));
    assert.ok(!JSON.stringify(profile).includes('云溪')&&!JSON.stringify(profile).includes('虚构'));
  }
  assert.deepEqual(Object.keys(guide.profiles),['scenic']);
});

for(const schema of [1,2])test(`schema ${schema} three-scene data is archived once before consolidating tourism`,async t=>{
  const {base,root}=await setup(t),privateRoot=path.join(root,'.private');
  const initial=await (await fetch(base+'/api/guide')).json();
  const extraIds=schema===1?['museum','exhibition']:['heritage','ecology'];
  const legacy={schema,selectedScene:extraIds[0],profiles:{
    scenic:{...initial.profiles.scenic,venue:'已保存的真实景区',demo:false},
    [extraIds[0]]:{...initial.profiles.scenic,venue:'待备份的第二套资料',highlights:'原始讲解资料 A17。'},
    [extraIds[1]]:{...initial.profiles.scenic,venue:'待备份的第三套资料',highlights:'原始讲解资料 Q28。'},
  }};
  await mkdir(privateRoot,{recursive:true});const filename=path.join(privateRoot,'guide-scenes.json');
  const source=JSON.stringify(legacy,null,2);await writeFile(filename,source);
  const responses=await Promise.all(Array.from({length:3},()=>fetch(base+'/api/guide').then(r=>r.json())));
  for(const current of responses){
    assert.equal(current.selectedScene,'scenic');assert.deepEqual(current.profiles,{scenic:legacy.profiles.scenic});
    assert.equal(current.scenes.length,1);assert.equal(current.scenes[0].label,'旅游景区');
    assert.ok(!JSON.stringify(current).includes('待备份')&&!JSON.stringify(current).includes('A17'));
  }
  assert.equal(JSON.parse(await readFile(filename,'utf8')).schema,3);
  const backups=(await readdir(privateRoot)).filter(name=>name.startsWith('guide-scenes.before-single-tourism.'));
  assert.equal(backups.length,1);assert.equal(await readFile(path.join(privateRoot,backups[0]),'utf8'),source);
  assert.equal((await fetch(base+'/.private/'+backups[0])).status,404);
  const malformed={...legacy,profiles:{...legacy.profiles,[extraIds[0]]:null}};await writeFile(filename,JSON.stringify(malformed));
  assert.equal((await fetch(base+'/api/guide')).status,500);assert.deepEqual(JSON.parse(await readFile(filename,'utf8')),malformed);
  assert.equal((await readdir(privateRoot)).filter(name=>name.startsWith('guide-scenes.before-single-tourism.')).length,1);
});

test('the single tourism profile persists through concurrent saves and service restart',async t=>{
  const {root,base,post}=await setup(t);
  const initial=await (await fetch(base+'/api/guide')).json();
  const profile={...initial.profiles.scenic,venue:'测试旅游景区',highlights:'石桥：讲解点编号 A17。',demo:false};
  assert.equal((await post({sceneId:'scenic',profile})).status,200);
  await Promise.all([post({sceneId:'scenic'}),post({sceneId:'scenic',profile})]);
  const second=createServer({dataRoot:root,localVoice:{close(){}},localAvatar:{attach(){},close(){},publicConfig:()=>({enabled:false})}});
  await new Promise(resolve=>second.listen(0,'127.0.0.1',resolve));
  try {
    const saved=await (await fetch(`http://127.0.0.1:${second.address().port}/api/guide`)).json();
    assert.equal(saved.selectedScene,'scenic');assert.deepEqual(saved.profiles,{scenic:profile});
    assert.equal(saved.scenes.length,1);
  }finally{await new Promise(resolve=>second.close(resolve));}
});

test('guide rejects malformed or excessive knowledge and foreign writes without publishing private files',async t=>{
  const {base,post}=await setup(t);
  const original=await (await fetch(base+'/api/guide')).json();
  for(const body of [{sceneId:'unknown'},{sceneId:'museum'},{sceneId:'heritage'},{sceneId:'ecology'},{sceneId:'scenic',profile:null},{sceneId:'scenic',profile:{venue:'测试景区',overview:'字'.repeat(601),demo:true}},{sceneId:'scenic',profile:{...original.profiles.scenic,demo:'false'}}])
    assert.equal((await post(body)).status,400);
  assert.deepEqual(await (await fetch(base+'/api/guide')).json(),original);
    assert.equal((await fetch(base+'/api/guide',{method:'POST',headers:{origin:'https://other.invalid','content-type':'application/json'},body:JSON.stringify({sceneId:'scenic'})})).status,403);
  assert.equal((await fetch(base+'/.private/guide-scenes.json')).status,404);
  assert.equal((await fetch(base+'/knowledge/catalog.json')).status,404);
});

test('the real voice bridge reads only the selected stored venue facts and preserves the cloned speaker',async t=>{
  const root=await mkdtemp(path.join(parent,'guide-voice-'));
  const upstreamServer=http.createServer(),upstream=new WebSocketServer({server:upstreamServer});
  await new Promise(resolve=>upstreamServer.listen(0,'127.0.0.1',resolve));
  const doubao=new DoubaoService(root,{encryption:fakeEncryption,upstreamURL:`ws://127.0.0.1:${upstreamServer.address().port}`});
  await doubao.saveSettings({authMode:'api-key',apiKey:'fixture-guide-private-key',voiceId:'S_fixture_guide',ownVoiceConfirmed:true});
  const server=createServer({dataRoot:root,doubao,localVoice:{close(){}},localAvatar:{attach(){},close(){},publicConfig:()=>({enabled:false})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{doubao.close();for(const s of upstream.clients)s.terminate();upstream.close();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>upstreamServer.close(resolve))]);assert.ok(root.startsWith(parent+path.sep));await rm(root,{recursive:true,force:true});});
  const initial=await (await fetch(origin+'/api/guide')).json();
  assert.equal((await fetch(origin+'/api/guide',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sceneId:'scenic',profile:{venue:'测试旅游景区',overview:'用于验证当前已保存景区资料。',highlights:'石桥的讲解点编号为 A17。',route:'石桥',visitorInfo:'测试信息；没有票务工具。',contact:'测试服务台',demo:false}})})).status,200);
  let connections=0;
  const started=new Promise(resolve=>upstream.on('connection',socket=>{
    connections++;socket.on('message',bytes=>{
      const frame=decodeFrame(bytes);
      if(frame.event===1)socket.send(encodeFrame(50,{},'connection',9));
      if(frame.event===100){resolve(frame.payload);socket.send(encodeFrame(150,{},frame.sessionId,9));}
      if(frame.event===102)socket.send(encodeFrame(152,{},frame.sessionId,9));
    });
  }));
  const client=new WebSocket(origin.replace('http','ws')+'/api/doubao/live',{origin});await once(client,'open');
  client.send(JSON.stringify({type:'start',guideScene:'scenic',instructions:'你的名字是李云龙。对孩子用简单易懂的语言讲解。'}));
  const session=await started;
  assert.equal(session.tts.speaker,'S_fixture_guide');assert.equal(session.dialog.extra.model,'2.2.0.0');
  const prompt=session.dialog.character_manifest;
  assert.ok(prompt.includes('景区讲解员')&&prompt.includes('测试旅游景区')&&prompt.includes('A17')&&prompt.includes('孩子'));
  assert.ok(prompt.includes('景区旅游讲解')&&!prompt.includes('博物馆')&&!prompt.includes('企业展厅'));
  assert.ok(!prompt.includes('李云龙'),'old browser identity must not enter the venue session');
  assert.ok(!prompt.includes(initial.profiles.scenic.venue)&&!prompt.includes('三个场景'));
  assert.ok(prompt.includes('自然、清晰、利落')&&prompt.includes('不故意拖长元音')&&prompt.includes('不要撒娇'));
  assert.ok(prompt.indexOf('发声要求')>prompt.indexOf('交流偏好'),'delivery policy must reach the cloud after saved expression preferences');
  assert.ok(prompt.includes('不能编造')&&prompt.includes('事实')&&prompt.includes('工作人员'));
  client.close();await once(client,'close');
  const bad=new WebSocket(origin.replace('http','ws')+'/api/doubao/live',{origin});await once(bad,'open');
  const received=once(bad,'message');bad.send(JSON.stringify({type:'start',guideScene:'unknown'}));
  assert.equal(JSON.parse((await received)[0].toString()).type,'error');await once(bad,'close');assert.equal(connections,1);
});
