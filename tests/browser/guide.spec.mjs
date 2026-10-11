import { test,expect } from '@playwright/test';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createServer } from '../../server.mjs';
import { DoubaoService } from '../../doubao-service.mjs';
import { encodeFrame,decodeFrame } from '../../doubao-protocol.mjs';

let server,upstream,upstreamServer,root,base,sessions;
const parent=path.resolve('output');
test.beforeEach(async()=>{
  root=await mkdtemp(path.join(parent,'guide-browser-'));sessions=[];
  upstreamServer=http.createServer();upstream=new WebSocketServer({server:upstreamServer});
  await new Promise(resolve=>upstreamServer.listen(0,'127.0.0.1',resolve));
  upstream.on('connection',socket=>socket.on('message',bytes=>{
    const frame=decodeFrame(bytes);
    if(frame.event===1)socket.send(encodeFrame(50,{},'connection',9));
    if(frame.event===100){sessions.push(frame.payload);socket.send(encodeFrame(150,{},frame.sessionId,9));}
    if(frame.event===102)socket.send(encodeFrame(152,{},frame.sessionId,9));
  }));
  const doubao=new DoubaoService(root,{encryption:{id:'test-only',encrypt:async s=>Buffer.from(s),decrypt:async b=>b.toString()},upstreamURL:`ws://127.0.0.1:${upstreamServer.address().port}`});
  await doubao.saveSettings({authMode:'api-key',apiKey:'fixture-browser-voice-key',voiceId:'S_fixture_guide',ownVoiceConfirmed:true});
  server=createServer({dataRoot:root,doubao,config:{apiKey:null},localVoice:{publicStatus:async()=>({available:false}),close(){}},localAvatar:{publicConfig:()=>({enabled:false}),attach(){},close(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
test.afterEach(async()=>{
  server.doubao.close();for(const socket of upstream.clients)socket.terminate();upstream.close();
  await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>upstreamServer.close(resolve))]);
  expect(root.startsWith(parent+path.sep)).toBe(true);await rm(root,{recursive:true,force:true});
});

test('one tourism entry loads and persists while conversation remains voice only',async({page})=>{
  await page.goto(base);await expect(page.locator('.guide-scene')).toHaveCount(1);
  await expect(page.locator('.guide-scene strong')).toHaveText('承德避暑山庄');
  await expect(page.locator('button[data-guide-scene]')).toHaveCount(0);
  await expect(page.locator('#guide-demo-label')).toBeHidden();
  await expect(page.locator('#guide-title')).toHaveText('承德避暑山庄');
  await expect(page.locator('#guide-heading-name')).toHaveText('承德避暑山庄');
  await expect(page.locator('#guide-nav')).toHaveText('承德避暑山庄');
  await expect(page.locator('#guide-inspiration')).toContainText('烟雨楼');
  await expect(page.locator('#guide-role')).toHaveText('景区讲解员');
  await expect(page.locator('#guide-intro')).toContainText('景区讲解员');
  await expect(page.locator('#portrait')).toHaveAttribute('alt','景区讲解员的数字人形象');
  await expect(page).toHaveTitle('承德避暑山庄 · 景区讲解员');
  expect(await page.locator('body').innerText()).not.toMatch(/李云龙|博物馆|企业展厅|古镇人文|生态休闲|三个场景/);
  await page.reload();await expect(page.locator('#guide-title')).toHaveText('承德避暑山庄');
  await expect(page.locator('#chat')).toBeHidden();await expect(page.locator('#subtitle')).toBeHidden();await expect(page.locator('#text-form')).toBeHidden();
  await mkdir('output/chengde-frontend',{recursive:true});
  await page.screenshot({path:'output/chengde-frontend/desktop.png',fullPage:true,animations:'disabled'});
  await page.locator('#connect').click();await expect(page.locator('#connection-summary')).toHaveText('语音对话已连接');
  expect(sessions).toHaveLength(1);const session=sessions[0];
  expect(session.dialog.character_manifest).toContain('承德避暑山庄');
  expect(session.dialog.character_manifest).toContain('1703');expect(session.dialog.character_manifest).toContain('1994');
  expect(session.dialog.character_manifest).toContain('烟雨楼');expect(session.dialog.character_manifest).toContain('现场公告');
  expect(session.dialog.character_manifest).not.toContain('云溪');expect(session.dialog.character_manifest).not.toContain('这是虚构景区演示');
  expect(session.tts.speaker).toBe('S_fixture_guide');
  await page.locator('#connect').click();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'output/chengde-frontend/mobile.png',fullPage:true,animations:'disabled'});
});

test('saved tourism knowledge reaches the real voice bridge with the own speaker',async({page})=>{
  await page.goto(base);await expect(page.locator('#guide-title')).toHaveText('承德避暑山庄');
  await page.locator('#settings-open').click();
  await page.locator('#guide-venue-input').fill('测试古镇景区');await page.locator('#guide-overview').fill('以街巷漫步与建筑观察为主题。');
  await page.locator('#guide-highlights').fill('测试景点：石桥，讲解点编号 Q28。');await page.locator('#guide-demo').uncheck();
  await page.locator('#guide-save').click();await expect(page.locator('#guide-save-status')).toContainText('已保存');
  await page.locator('#settings-close').click();await expect(page.locator('#guide-title')).toHaveText('测试古镇景区');await expect(page.locator('#guide-demo-label')).toBeHidden();
  await expect(page.locator('#guide-heading-name')).toHaveText('测试古镇景区');
  await expect(page.locator('#guide-nav')).toHaveText('测试古镇景区');
  await expect(page).toHaveTitle('测试古镇景区 · 景区讲解员');
  await expect(page.locator('#guide-inspiration')).not.toContainText('烟雨楼');
  await expect(page.locator('#guide-eyebrow')).not.toContainText('CHENGDE');
  await page.locator('#connect').click();await expect(page.locator('#connection-summary')).toHaveText('语音对话已连接');
  expect(sessions).toHaveLength(1);const voice=sessions[0];
  expect(voice.dialog.character_manifest).toContain('测试古镇景区');expect(voice.dialog.character_manifest).toContain('Q28');
  expect(voice.dialog.character_manifest).toContain('景区讲解员');expect(voice.dialog.character_manifest).not.toContain('李云龙');
  expect(voice.dialog.character_manifest).not.toMatch(/博物馆|企业展厅/);
  expect(voice.dialog.character_manifest).not.toContain('三个场景');expect(voice.tts.speaker).toBe('S_fixture_guide');
  const after=await (await page.request.get(base+'/api/guide')).json();expect(Object.keys(after.profiles)).toEqual(['scenic']);expect(after.profiles.scenic.venue).toBe('测试古镇景区');
  await page.locator('#connect').click();
});

test('saving tourism facts ends the old microphone and uses the new facts in a fresh session',async({page})=>{
  await page.addInitScript(()=>{const acquire=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async options=>{const stream=await acquire(options);window.guideMicrophone=stream;return stream;};});
  await page.goto(base);await page.locator('#connect').click();await expect(page.locator('#connection-summary')).toHaveText('语音对话已连接');
  await page.locator('#settings-open').click();await page.locator('#guide-venue-input').fill('更新后的旅游景区');
  await page.locator('#guide-overview').fill('更新后的旅游景区测试简介。');
  await page.locator('#guide-save').click();await expect(page.locator('#guide-save-status')).toContainText('已保存');
  await page.locator('#settings-close').click();await expect(page.locator('#guide-title')).toHaveText('更新后的旅游景区');
  expect(await page.evaluate(()=>guideMicrophone.getAudioTracks()[0].readyState)).toBe('ended');
  await expect(page.locator('#connect')).toContainText('开始对话');
  await page.locator('#connect').click();await expect(page.locator('#connection-summary')).toHaveText('语音对话已连接');
  expect(sessions).toHaveLength(2);expect(sessions[1].dialog.character_manifest).toContain('更新后的旅游景区');expect(sessions[1].dialog.character_manifest).not.toContain('承德避暑山庄');
  expect(sessions.every(session=>session.dialog.character_manifest.includes('景区讲解员'))).toBe(true);
  expect(sessions.every(session=>!session.dialog.character_manifest.includes('李云龙'))).toBe(true);
  await page.locator('#connect').click();
});

test('a failed knowledge save keeps edits and does not claim the stored venue changed',async({page})=>{
  await page.goto(base);await expect(page.locator('#guide-title')).toHaveText('承德避暑山庄');
  await page.locator('#settings-open').click();await page.locator('#guide-venue-input').fill('尚未保存的测试景区');
  await page.route('**/api/guide',route=>route.request().method()==='POST'?route.fulfill({status:500,json:{error:'测试保存失败'}}):route.continue());
  await page.locator('#guide-save').click();await expect(page.locator('#guide-save-status')).toHaveText('测试保存失败');
  await expect(page.locator('#guide-venue-input')).toHaveValue('尚未保存的测试景区');await expect(page.locator('#guide-title')).toHaveText('承德避暑山庄');
});

test('the main settings save also saves edited venue knowledge and stays open on failure',async({page})=>{
  await page.goto(base);await page.locator('#settings-open').click();
  await page.locator('#guide-venue-input').fill('一键保存的演示景区');await page.locator('#settings-save').click();
  await expect(page.locator('#settings')).toBeHidden();await expect(page.locator('#guide-title')).toHaveText('一键保存的演示景区');
  expect((await (await page.request.get(base+'/api/guide')).json()).profiles.scenic.venue).toBe('一键保存的演示景区');
  await page.locator('#settings-open').click();await page.locator('#guide-venue-input').fill('不应丢失的未保存资料');
  await page.route('**/api/guide',route=>route.request().method()==='POST'?route.fulfill({status:500,json:{error:'测试保存失败'}}):route.continue());
  await page.locator('#settings-save').click();await expect(page.locator('#settings')).toBeVisible();await expect(page.locator('#guide-venue-input')).toHaveValue('不应丢失的未保存资料');
});
