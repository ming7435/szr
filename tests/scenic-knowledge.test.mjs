import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const catalogURL=new URL('../knowledge/catalog.json',import.meta.url);
const load=url=>readFile(url,'utf8').then(JSON.parse);
test('scenic knowledge has unique venue IDs, traceable sources and explicit expired notices',async()=>{
  const catalog=await load(catalogURL);
  assert.equal(catalog.schema,1);
  assert.equal(new Set(catalog.scenicAreas.map(area=>area.id)).size,catalog.scenicAreas.length);
  assert.ok(catalog.scenicAreas.some(area=>area.id===catalog.defaultScenicId));
  for(const area of catalog.scenicAreas){
    for(const field of ['profile','sources','documents']){
      const url=new URL(area[field],catalogURL);
      assert.ok(url.href.startsWith(new URL('./',catalogURL).href),'bundled paths must remain inside knowledge');
    }
    const [profile,sources,documents]=await Promise.all(['profile','sources','documents'].map(field=>load(new URL(area[field],catalogURL))));
    assert.equal(profile.venue,area.name);assert.equal(profile.demo,false);
    const sourceIds=new Set(sources.map(source=>source.id));assert.equal(sourceIds.size,sources.length);
    assert.equal(new Set(documents.map(doc=>doc.id)).size,documents.length);
    for(const source of sources){assert.equal(new URL(source.url).protocol,'https:');assert.match(source.checkedAt,/^\d{4}-\d{2}-\d{2}$/);}
    for(const doc of documents){
      assert.equal(doc.scenicId,area.id);assert.ok(doc.content&&doc.title&&doc.sourceIds.length);
      for(const id of doc.sourceIds)assert.ok(sourceIds.has(id),`missing source ${id}`);
      for(const field of doc.profileFields)assert.equal(typeof profile[field],'string');
      if(doc.status==='expired'){
        assert.ok(doc.validFrom<=doc.validTo&&doc.validTo<area.checkedAt);
        assert.deepEqual(doc.profileFields,[],'expired notice must not supply an active profile field');
        assert.ok(!JSON.stringify(profile).includes(doc.content),'archive must not enter the active session');
      }
    }
    for(const field of ['overview','highlights','route','visitorInfo','contact'])assert.ok(documents.some(doc=>doc.status!=='expired'&&doc.profileFields.includes(field)),`untraced profile field ${field}`);
    assert.ok(documents.some(doc=>doc.kind==='suggestion'&&doc.topic==='route'),'route advice must be separate from historical facts');
  }
});
