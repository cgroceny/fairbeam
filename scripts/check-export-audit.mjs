import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startStack, chromePath } from './scenarios/stack.mjs';
let stack, browser;
try {
  stack = await startStack({niceSolver:false,log:console.log});
  browser = await puppeteer.launch({headless:true,executablePath:await chromePath(),args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader']});
  const page = await browser.newPage();
  await page.goto(stack.url,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('.home');
  await page.evaluate(async()=>{
    const {api}=await import('/src/runner/api.ts');
    const {openDesign}=await import('/src/designer/store.ts');
    const {setAppMode}=await import('/src/workspace.ts');
    const created=await api.createDesign({id:'invalid_export_audit',name:'Invalid saved design'});
    created.design.parts.push({name:'broken',material:created.design.materials[0].name,primitives:[{kind:'box',start:[0,0,0],stop:['unresolved_parameter',20,1]}]});
    await api.saveDesign(created.id,created.design,created.hash);
    // A cleared result/preview is a legitimate navigation state; export must not
    // require a previous model merely to show the current draft's build error.
    (await import('/src/state.ts')).clearProject();
    await openDesign(created.id);setAppMode('design');
  });
  await page.waitForSelector('.rb');
  await new Promise(resolve=>setTimeout(resolve,1200));
  const before=await page.evaluate(async()=>{
    const state=await import('/src/state.ts');
    const context=await import('/src/components/exportContext.ts');
    return {hasBundle:!!state.bundle(),geometryAvailable:context.geometryAvailable()};
  });
  console.log('Initial failed design preview:',before);
  assert.equal(before.hasBundle,false);
  assert.equal(before.geometryAvailable,true);
  await page.click('.header-cst');
  await page.waitForSelector('[data-export-action="geometry"]');
  await page.click('[data-export-action="geometry"]');
  await page.waitForSelector('[aria-labelledby="export-title"]',{timeout:5000});
  await page.waitForSelector('[aria-labelledby="export-title"] [role="alert"]');
  const detail=await page.$eval('[aria-labelledby="export-title"] [role="alert"]',el=>el.textContent);
  assert.match(detail,/unresolved|unknown|parameter/i);
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('[aria-labelledby="export-title"]'));
  console.log('Export audit: invalid initial native preview opens dialog, shows error and closes with Escape');
} finally {
  if (process.platform === 'win32') {
    // Chromium close can wait on a beforeunload prompt; Python venv launchers
    // also have real-interpreter children. Stop only this test's owned trees.
    for (const pid of [browser?.process()?.pid, ...(stack?.pids ?? [])].filter(Boolean)) {
      await promisify(execFile)('taskkill', ['/PID', String(pid), '/T', '/F'], {windowsHide:true}).catch(()=>{});
    }
  } else { await browser?.close(); }
  await stack?.stop();
}

