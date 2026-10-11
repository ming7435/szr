const $=id=>document.getElementById(id);
const keys=['venue','overview','highlights','route','visitorInfo','contact'];
const inputs={venue:'guide-venue-input',overview:'guide-overview',highlights:'guide-highlights',route:'guide-route',visitorInfo:'guide-visitor-info',contact:'guide-contact'};

export class GuidePanel {
  constructor({beforeSwitch,onChange,onError}) {
    Object.assign(this,{beforeSwitch,onChange,onError});this.loading=true;this.saving=false;
    $('guide-form').addEventListener('submit',event=>{event.preventDefault();this.save();});
  }
  get ready(){return !!this.value;}
  get selectedScene(){return this.value?.selectedScene;}
  get current(){return this.value?.scenes.find(scene=>scene.id===this.selectedScene);}
  get dirty(){const profile=this.value?.profiles[this.selectedScene];return !!profile&&(keys.some(key=>$(inputs[key]).value.trim()!==profile[key])||$('guide-demo').checked!==profile.demo);}
  async request(body) {
    const response=await fetch('/api/guide',body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
    const value=await response.json();if(!response.ok)throw new Error(value.error||'景区资料未能加载。');return value;
  }
  apply(value) {
    if(!Array.isArray(value.scenes)||value.scenes.length!==1||value.selectedScene!=='scenic'||
       value.scenes.some(scene=>scene.id!=='scenic'||typeof scene.label!=='string'||typeof scene.role!=='string'||!Array.isArray(scene.questions)||scene.questions.length<2||
       typeof value.profiles?.[scene.id]?.demo!=='boolean'||keys.some(key=>typeof value.profiles[scene.id][key]!=='string')))throw new Error('景区资料格式不正确，请重新加载。');
    this.value=value;
    const scene=this.current,profile=value.profiles[this.selectedScene];
    const isChengde=!profile.demo&&profile.venue==='承德避暑山庄';
    document.body.dataset.guideScene=scene.id;
    document.title=`${profile.venue} · ${scene.role}`;
    $('guide-nav').textContent=profile.venue;
    $('guide-heading-name').textContent=profile.venue;
    $('guide-heading-tagline').textContent=isChengde?'宫苑山水，边走边听。':'让每次游览，都有回应。';
    $('guide-eyebrow').textContent=isChengde?'CHENGDE · MOUNTAIN RESORT':'EXPLORE, ASK, DISCOVER';
    $('guide-scene-name').textContent=profile.venue;
    $('guide-scene-description').textContent=`${scene.label} · ${isChengde?'宫殿建筑 · 湖区园林 · 游览咨询':scene.description}`;
    $('guide-role').textContent=scene.role;$('guide-intro').textContent=`${scene.role} · ${isChengde?'历史故事与游览咨询':'你的旅游讲解助手'}`;
    $('portrait').alt=`${scene.role}的数字人形象`;
    $('guide-title').textContent=profile.venue;$('guide-venue').textContent=`${scene.role} · 实时语音导览`;
    $('guide-demo-label').hidden=!profile.demo;
    const questions=isChengde?['烟雨楼有什么来历','第一次来怎么游览']:scene.questions;
    $('guide-inspiration').textContent=`试着说：「${questions[0]}」或「${questions[1]}」。`;
    $('guide-footer-note').textContent=isChengde?'从宫殿到湖区，听懂山庄的故事。':'边游览，边提问。让风景有故事。';
    $('guide-settings-scene').textContent=`当前景区：${profile.venue}`;
    for(const key of keys)$(inputs[key]).value=profile[key];$('guide-demo').checked=profile.demo;
  }
  updateControls() {
    $('guide-save').disabled=this.loading||this.saving||!this.ready;
    $('guide-fields').disabled=this.loading||this.saving||!this.ready;
    $('settings-save').disabled=this.saving;
    this.onChange();
  }
  async load() {
    try {this.apply(await this.request());$('guide-save-status').textContent='资料保存在本机，修改后点击保存。';}
    catch(error){$('guide-save-status').textContent=error.message;this.onError('讲解场景未能加载，请刷新页面或检查本机服务。');}
    finally {this.loading=false;this.updateControls();}
  }
  async change(body) {
    if(this.loading||this.saving||!this.ready)return;
    this.beforeSwitch();this.saving=true;this.updateControls();$('guide-save-status').textContent='正在保存讲解资料…';
    try {this.apply(await this.request(body));$('guide-save-status').textContent='景区资料已保存，下一次对话使用当前内容。';return true;}
    catch(error){$('guide-save-status').textContent=error.message;this.onError(error.message);return false;}
    finally {this.saving=false;this.updateControls();}
  }
  save() {
    const profile=Object.fromEntries(keys.map(key=>[key,$(inputs[key]).value]));profile.demo=$('guide-demo').checked;
    return this.change({sceneId:this.selectedScene,profile});
  }
}
