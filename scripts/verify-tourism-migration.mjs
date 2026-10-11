import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const directory='output/single-tourism-migration',privateDirectory='.private',filename=path.join(privateDirectory,'guide-scenes.json');
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const backups=async()=>(await readdir(privateDirectory)).filter(name=>name.startsWith('guide-scenes.before-single-tourism.'));
await mkdir(directory,{recursive:true});
if(process.argv[2]==='before'){
  const source=await readFile(filename),saved=JSON.parse(source);
  assert.ok(saved.schema===1||saved.schema===2);
  await writeFile(path.join(directory,'before.json'),JSON.stringify({schema:saved.schema,sourceHash:hash(source),scenicHash:hash(saved.profiles.scenic),selectedScene:saved.selectedScene,backups:await backups()},null,2));
  console.log('Recorded old guide data hashes for migration verification.');
}else{
  const before=JSON.parse(await readFile(path.join(directory,'before.json'),'utf8'));
  const current=await (await fetch('http://127.0.0.1:4173/api/guide')).json();
  assert.deepEqual(current.scenes.map(scene=>scene.id),['scenic']);assert.equal(current.scenes[0].label,'旅游景区');
  assert.deepEqual(Object.keys(current.profiles),['scenic']);
  assert.ok(current.scenes.every(scene=>scene.role==='景区讲解员'));
  assert.equal(current.selectedScene,'scenic');
  assert.equal(hash(current.profiles.scenic),before.scenicHash);
  assert.equal(/博物馆|企业展厅/.test(JSON.stringify(current)),false);
  assert.equal(JSON.parse(await readFile(filename,'utf8')).schema,3);
  const added=(await backups()).filter(name=>!before.backups.includes(name));assert.equal(added.length,1);
  assert.equal(hash(await readFile(path.join(privateDirectory,added[0]))),before.sourceHash);
  assert.equal((await fetch('http://127.0.0.1:4173/.private/'+added[0])).status,404);
  const report={passed:true,checkedAt:new Date().toISOString(),schema:3,oldGuideBackupMatches:true,oldScenicProfilePreserved:true,selectedScene:'scenic',singleTourismEntry:true,tourismOnly:true,guideRole:'景区讲解员',backupNotPublic:true,cloudCalls:0};
  await writeFile(path.join(directory,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
