// Opt-in real-WebGL regression. Run with a freshly started Vite checkout + API and temporary qa_patch.
// FAIRBEAM_BROWSER_TESTS=1 FAIRBEAM_PUPPETEER=/path/to/puppeteer-core.js node scripts/check-viewport-browser.mjs
if(process.env.FAIRBEAM_BROWSER_TESTS!=='1') {
 console.log('SKIP viewport browser checks: opt in with FAIRBEAM_BROWSER_TESTS=1.');process.exit(0);
}
const {default:puppeteer}=await import(process.env.FAIRBEAM_PUPPETEER || 'puppeteer-core');
const browser=await puppeteer.launch({headless:true,executablePath:process.env.FAIRBEAM_CHROME || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),args:['--no-sandbox']});
try {
 const page=await browser.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.FAIRBEAM_TEST_URL || 'http://127.0.0.1:5420/',{waitUntil:'networkidle0'});
 await page.waitForSelector('.home');
 const results=await page.evaluate(async id=>{
  const d=await import('/src/designer/store.ts'), s=await import('/src/state.ts'),r=await import('/src/runner/store.ts');
  const w=await import('/src/workspace.ts');
  const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const check=(ok,text)=>{if(!ok)throw new Error(text);out.push(text);},out=[];
  await d.enterDesign(id);
  const deadline=Date.now()+10000;
  while(r.previewState()!=='ready' && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
  check(r.previewState()==='ready','server preview ready');await frame();
  const ids=()=>{const list=[];window.__fairbeam.scene.traverse(o=>{if(o.geometry)list.push(o.geometry.uuid);});return JSON.stringify(list);};
  const before=ids(),camera=window.__fairbeam.camera.position.toArray().join(',');
  for(let i=0;i<6;i++){s.setLayers('dielectricXray',i%2===0);await frame();check(ids()===before,`X-ray toggle ${i+1} reuses geometry`);}
  const dielectric=()=>{const list=[];window.__fairbeam.scene.traverse(o=>{if(o.userData.part&&o.material?.metalness===0)list.push(o.material);});return list;};
  check(dielectric().length>0&&dielectric().every(m=>m.opacity===0.9&&m.depthWrite),'opaque dielectric base restored');
  s.setSolidFade(true);s.setLayers('dielectricXray',true);await frame();
  check(dielectric().every(m=>m.opacity===0.22&&!m.depthWrite),'mesh fade composes with X-ray');
  s.setSolidFade(false);await frame();
  check(dielectric().every(m=>m.opacity===0.38&&!m.depthWrite),'unfading restores X-ray base');
  check(window.__fairbeam.camera.position.toArray().join(',')===camera,'X-ray and fade preserve camera');
  s.setLayers('dielectricXray',false);
  const {quickBundle}=await import('/src/designer/geometry.ts');
  const quick=quickBundle(JSON.parse(JSON.stringify(d.draft)),d.names().names,null);
  s.openBundle(quick,'Coarse preview test');await frame();
  const port=window.__fairbeam.scene.getObjectByName('port-1');
  check(!!port&&port.children.filter(c=>c.geometry?.type==='SphereGeometry').every(c=>c.geometry.parameters.radius<2),'coarse preview port glyph stays bounded');
  const memory=[];
  for(let i=0;i<3;i++){
   const old=window.__fairbeam.renderer;
   document.querySelector('.vp-canvas').dispatchEvent(new PointerEvent('pointermove',{clientX:450,clientY:300}));
   w.setAppMode('home');await frame();
   check(old.getContext().isContextLost(),`unmount ${i+1} releases WebGL context`);
   w.setAppMode('design');await frame();
   check(window.__fairbeam.renderer!==old,`remount ${i+1} creates a fresh renderer`);
   memory.push(window.__fairbeam.renderer.info.memory.geometries);
  }
  check(memory.every(n=>n===memory[0]),`remount geometry count stays bounded: ${memory.join(', ')}`);
  return out;
 },process.env.FAIRBEAM_TEST_DESIGN || 'qa_patch');
 for(const result of results)console.log(`PASS ${result}`);
 if(errors.length)throw new Error(errors.join('\n'));
 console.log(`${results.length} browser viewport checks passed; no page errors.`);
}finally{await browser.close();}
