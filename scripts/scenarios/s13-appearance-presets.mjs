import assert from 'node:assert/strict';
async function openAppearance(s) {
 await s.click('header.settings');await s.wait('#gs-title');await s.clickSel('#gs-tab-appearance');
 await s.waitFor(()=>document.querySelector('#gs-tab-appearance')?.getAttribute('aria-selected')==='true'&&!!document.querySelector('#gs-panel-appearance select'),null,{what:'selected appearance panel'});
}
export default {id:'S13',title:'Appearance presets and individual reset',async run(s){
 await s.step('default tokens and keyboard appearance settings',async()=>{
  await s.page.goto(s.url,{waitUntil:'domcontentloaded'});await s.wait('.home');
  assert.equal(await s.page.evaluate(()=>document.documentElement.style.getPropertyValue('--al-action')),'');
  await s.click('header.settings');await s.wait('#gs-title');await s.clickSel('#gs-tab-general');await s.press('ArrowRight');
  assert.equal(await s.page.evaluate(()=>document.activeElement.id),'gs-tab-appearance');
 });
 await s.step('presets persist and update shared chart and viewport tokens',async()=>{
  for(const[key,value]of Object.entries({colorPreset:'ocean',accent:'teal',chartPalette:'accessible',chartWeight:'3',viewportPalette:'blueprint'}))await s.page.select(`[data-appearance="${key}"]`,value);
  const tokens=await s.page.evaluate(()=>({action:document.documentElement.style.getPropertyValue('--al-action'),weight:getComputedStyle(document.querySelector('.gs-style-preview .c-line')).strokeWidth,grid:document.documentElement.style.getPropertyValue('--al-viewport-grid')}));
  assert.ok(tokens.action);assert.equal(tokens.weight,'3px');assert.ok(tokens.grid);
  await s.page.reload({waitUntil:'domcontentloaded'});await s.wait('.home');await openAppearance(s);
  assert.equal(await s.page.$eval('[data-appearance="accent"]',el=>el.value),'teal');
  await s.page.$eval('.gs-custom-colors',el=>el.open=true);
  for(const key of ['customAccent','traceColor','viewportColor','gridColor']){
   await s.page.$eval(`[data-custom-enabled="${key}"]`,el=>el.click());
   await s.page.$eval(`[data-custom-color="${key}"]`,el=>{el.value='#1234ab';el.dispatchEvent(new Event('input',{bubbles:true}));});
  }
  assert.equal(await s.page.evaluate(()=>document.documentElement.style.getPropertyValue('--al-series-1')),'#1234ab');
  await s.page.reload({waitUntil:'domcontentloaded'});await s.wait('.home');await openAppearance(s);
  assert.equal(await s.page.evaluate(()=>JSON.parse(localStorage.getItem('fairbeam.generalSettings')).gridColor),'#1234ab');
 });
 await s.step('individual reset and global reset restore exact incumbent tokens',async()=>{
  await s.page.$eval('[data-appearance="accent"]',el=>el.closest('.gs-appearance-choice').querySelector('button').click());
  await s.page.$eval('[data-custom-enabled="customAccent"]',el=>el.click());
  assert.equal(await s.page.evaluate(()=>document.documentElement.style.getPropertyValue('--al-action')),'');
  assert.equal(await s.page.$eval('[data-appearance="chartWeight"]',el=>el.value),'3');
  await s.page.$eval('#gs-panel-appearance > button',el=>el.click());
  assert.deepEqual(await s.page.evaluate(()=>['--al-action','--al-chart-line-weight','--al-series-1','--al-viewport'].map(k=>document.documentElement.style.getPropertyValue(k))),['','','','']);
 });
 await s.step('Header theme survives appearance save and reload; Settings updates Header',async()=>{
  await s.page.select('#gs-panel-appearance select','light');await s.press('Escape');
  await s.click('header.theme.light',{sel:'header button',attr:'aria-label'});
  assert.equal(await s.page.evaluate(()=>document.documentElement.dataset.theme),'dark');
  await openAppearance(s);
  await s.page.select('[data-appearance="chartWeight"]','3');await s.page.select('[data-appearance="colorPreset"]','ocean');
  await s.page.reload({waitUntil:'domcontentloaded'});await s.wait('.home');
  assert.deepEqual(await s.page.evaluate(()=>({display:document.documentElement.dataset.theme,legacy:localStorage.getItem('fairbeam.theme'),settings:JSON.parse(localStorage.getItem('fairbeam.generalSettings')).theme})),{display:'dark',legacy:'dark',settings:'dark'});
  await openAppearance(s);await s.page.select('#gs-panel-appearance select','light');await s.press('Escape');
  assert.ok(await s.find('header button',await s.T('header.theme.light'),{attr:'aria-label'}));
  await s.page.reload({waitUntil:'domcontentloaded'});await s.wait('.home');assert.equal(await s.page.evaluate(()=>document.documentElement.dataset.theme),'light');
  await openAppearance(s);await s.page.$eval('#gs-panel-appearance > button',el=>el.click());
 });
 await s.step('real Cartesian, polar and Smith plots update their rendered strokes live',async()=>{
  const result=await s.page.evaluate(async()=>{
   const [{render,LineChart,PolarChart,SmithChart},appearance,settings]=await Promise.all([import('/scripts/scenarios/chart-render-fixture.ts'),import('/src/lib/appearance.ts'),import('/src/lib/generalSettings.ts')]);
   const host=document.createElement('div');host.style.cssText='position:fixed;inset:0;background:var(--al-surface);z-index:9999;display:grid;grid-template-columns:repeat(3,1fr)';document.body.append(host);
   const common={id:'sample',label:'Sample',color:'--al-series-1'};
   const props=[{series:[{...common,x:[1,2,3],y:[-1,-5,-2]}],xLabel:'GHz',yLabel:'dB',ariaLabel:'Cartesian sample'},{series:[{...common,angle:[-90,0,90],value:[-5,0,-5]}],max:0,range:20,half:false,unit:'dBi',ariaLabel:'Polar sample'},{f:[1e9,2e9,3e9],re:[.1,.2,.3],im:[.2,.1,0],zRef:50,zRe:[50,50,50],zIm:[1,2,3],markers:[],ariaLabel:'Smith sample'}];
   const disposers=[LineChart,PolarChart,SmithChart].map((component,i)=>{const node=document.createElement('div');node.style.height='400px';host.append(node);return render(()=>component(props[i]),node);});
   const tick=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   const styles=()=>[...host.querySelectorAll('.c-line')].map(el=>({stroke:getComputedStyle(el).stroke,width:getComputedStyle(el).strokeWidth,d:el.getAttribute('d')}));
   const root=document.documentElement;const savedTheme=root.dataset.theme;const saved=settings.readGeneralSettings();const baseline={...settings.GENERAL_DEFAULTS};
   const output=[];
   for(const theme of ['light','dark']){
    root.dataset.theme=theme;appearance.applyAppearance(baseline);await tick();const original=styles();
    appearance.applyAppearance({...baseline,chartPalette:'accessible'});await tick();const palette=styles();
    appearance.applyAppearance({...baseline,chartPalette:'accessible',chartWeight:3,traceColor:'#1234ab'});await tick();const customized=styles();
    appearance.applyAppearance(baseline);await tick();output.push({theme,original,palette,customized,reset:styles()});
   }
   root.dataset.theme=savedTheme;appearance.applyAppearance(saved);disposers.forEach(dispose=>dispose());host.remove();return output;
  });
  for(const state of result){assert.equal(state.original.length,3);assert.ok(state.original.every(path=>path.d&&path.width==='2px'));assert.ok(state.palette.every(path=>path.stroke===(state.theme==='dark'?'rgb(121, 183, 239)':'rgb(33, 102, 172)')&&path.width==='2px'));assert.ok(state.customized.every(path=>path.stroke==='rgb(18, 52, 171)'&&path.width==='3px'));assert.deepEqual(state.reset,state.original,`${state.theme} defaults restore exact rendered paths`);}
 });
}};
