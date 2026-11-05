// Real Start screen and download flow, isolated data/profile, no solver runs.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { chromePath, startStack } from './scenarios/stack.mjs';

const screenshots = process.env.FAIRBEAM_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const stack = await startStack();
let browser;
try {
  browser = await puppeteer.launch({ executablePath: await chromePath(), headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'], timeout: 30000 });
  for (const lang of ['en','tr']) {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    await page.evaluateOnNewDocument(l => {
      localStorage.setItem('fairbeam.generalSettings', JSON.stringify({language:l}));
      const original = URL.createObjectURL;
      URL.createObjectURL = function(blob) { window.calculatorDownload = blob; return original.call(this,blob); };
    },lang);
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.setViewport({width:1440,height:1000});
    await page.goto(stack.url,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForSelector('.antenna-calculator summary',{visible:true,timeout:45000});
    await page.focus('.antenna-calculator summary'); await page.keyboard.press('Enter');
    await page.waitForSelector('.antenna-calc-results',{visible:true});
    const fill = async (index,text) => {
      const fields=await page.$$('.antenna-calculator input'); await fields[index].focus();
      const modifier=process.platform==='darwin'?'Meta':'Control';
      await page.keyboard.down(modifier); await page.keyboard.press('KeyA'); await page.keyboard.up(modifier);
      await page.keyboard.press('Backspace'); if(text) await page.keyboard.type(text);
    };
    await fill(0,'0');
    assert.equal(await page.$('.antenna-calc-results'),null);
    assert.equal(await page.$eval('.antenna-calculator button',b=>b.disabled),true);
    await fill(0,'-');
    assert.equal(await page.$('.antenna-calc-results'),null);
    await fill(0,'0,3');
    assert.equal(await page.$eval('.antenna-calculator input',e=>e.value),'0.3');
    await fill(1,'1');
    assert.match(await page.$eval('.antenna-calc-results',e=>e.textContent),/499\.6541/);
    await page.click('.antenna-calculator button');
    await page.waitForFunction(()=>!!window.calculatorDownload);
    const record=JSON.parse(await page.evaluate(()=>window.calculatorDownload.text()));
    assert.equal(record.inputs.frequencyGHz,.3); assert.equal(record.simulated,false);
    assert.equal(record.inputs.shortening,1); assert.equal(record.dimensions.armMm,record.dimensions.lengthMm/2);
    await page.select('.antenna-calculator select','monopole');
    assert.match(await page.$eval('.antenna-calc-results',e=>e.textContent),/249\.827/);
    await page.select('.antenna-calculator select','patch');
    await fill(0,'2.45');
    await page.waitForFunction(()=>document.querySelectorAll('.antenna-calc-results dd').length===5);
    await fill(2,'1000');
    assert.equal(await page.$('.antenna-calc-results'),null);
    await fill(2,'1.6');
    for (const width of [1440,390]) {
      await page.setViewport({width,height:width===390?1000:1000});
      await page.evaluate(()=>document.fonts.ready);
      const bounds=await page.$eval('.antenna-calculator',e=>({width:e.clientWidth,scroll:e.scrollWidth}));
      assert.ok(bounds.scroll<=bounds.width+1,`calculator overflow at ${width}/${lang}`);
      if(screenshots) await (await page.$('.antenna-calculator')).screenshot({path:join(screenshots,`calculator-${lang}-${width}.png`)});
    }
    assert.deepEqual(errors,[]);
    await context.close();
  }
  console.log('antenna calculator browser: EN/TR, keyboard disclosure, input errors/recovery, comma normalization, three types, full JSON export, 1440/390 widths PASS');
} finally { await browser?.close(); await stack.stop(); }
