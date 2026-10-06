// Opt-in browser check. Use a freshly started Vite server for this checkout and the local API.
// FAIRBEAM_BROWSER_TESTS=1 FAIRBEAM_PUPPETEER=/path/to/puppeteer-core.js node scripts/check-designer-accessibility.mjs
import assert from 'node:assert/strict';
if(process.env.FAIRBEAM_BROWSER_TESTS!=='1') {
 console.log('SKIP designer accessibility browser checks: opt in with FAIRBEAM_BROWSER_TESTS=1.');
  process.exit(0);
}
const {default:puppeteer}=await import(process.env.FAIRBEAM_PUPPETEER || 'puppeteer-core');
const browser=await puppeteer.launch({headless:true,executablePath:process.env.FAIRBEAM_CHROME || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),args:['--no-sandbox']});
try {
 const page=await browser.newPage();
 await page.goto(process.env.FAIRBEAM_TEST_URL || 'http://127.0.0.1:5420/',{waitUntil:'networkidle0'});
 await page.waitForSelector('.home');
 await page.evaluate(async id=>{const d=await import('/src/designer/store.ts');await d.enterDesign(id);},process.env.FAIRBEAM_TEST_DESIGN || 'qa_patch');
 await page.waitForSelector('.workspace.design-mode .rb');
 for(const width of [1440,1700]) {
  await page.setViewport({width,height:1050});
  await page.click('#rb-tab-model');
  const clipped=await page.evaluate(()=>[...document.querySelectorAll('.rb:not([hidden]) .rb-btn')].filter(el=>{
   const rect=el.getBoundingClientRect(),bar=el.closest('.rb').getBoundingClientRect();return rect.left<bar.left-1||rect.right>bar.right+1;
  }).map(el=>el.textContent));
  assert.deepEqual(clipped,[],`all ribbon actions fit at ${width}px`);
 }
 await page.focus('#rb-tab-model');
 await page.keyboard.press('ArrowRight');
 assert.equal(await page.$eval('#rb-tab-setup',el=>el===document.activeElement&&el.getAttribute('aria-selected')==='true'),true);
 await page.keyboard.press('End');
 assert.equal(await page.$eval('#rb-tab-sim',el=>el===document.activeElement),true);
 await page.keyboard.press('ArrowRight');
 assert.equal(await page.$eval('#rb-tab-model',el=>el===document.activeElement),true);
 await page.keyboard.press('End');await page.keyboard.press('Home');
 assert.equal(await page.$$eval('.rb-tab[tabindex="0"]',els=>els.length),1);
 assert.equal(await page.$$eval('[role="tabpanel"].rb',els=>els.filter(el=>!el.hidden).length),1);
 assert.equal(await page.$eval('#rb-tab-model',el=>document.getElementById(el.getAttribute('aria-controls')).getAttribute('aria-labelledby')===el.id),true);
 await page.evaluate(async()=>{const d=await import('/src/designer/store.ts');d.setSelection({type:'primitive',i:0,j:0});});
 await page.waitForSelector('.dw-right input[aria-describedby]');
 // Use the actual field ID convention rather than relying on CSS-escaped model paths.
 const field=await page.evaluate(async()=>{const d=await import('/src/designer/store.ts');return d.fieldId('parts[0].primitives[0].start[0]');});
 await page.evaluate(id=>{const el=document.getElementById(id);el.value='1/0';el.dispatchEvent(new Event('input',{bubbles:true}));},field);
 assert.equal(await page.evaluate(id=>{const el=document.getElementById(id);return el.getAttribute('aria-invalid')==='true'&&el.getAttribute('aria-describedby').split(' ').some(key=>document.getElementById(key)?.textContent);},field),true);
 console.log('PASS ribbon fits 1440/1700; arrow/Home/End tab navigation; panel associations; single tab stop; invalid expression description.');
}finally{await browser.close();}
