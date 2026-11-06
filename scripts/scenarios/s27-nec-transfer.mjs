import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default {
  id: 'S27', title: 'Explicit NEC wire import, editing and complete exports',
  async run(s, ctx) {
    const folder = mkdtempSync(join(tmpdir(), 'fairbeam-nec-transfer-'));
    const panel = '[data-testid="nec-transfer"]';
    const hash = text => createHash('sha256').update(text).digest('hex');
    const downloaded = async kind => {
      await s.page.evaluate(() => { window.__necDownload = null; });
      await s.page.click(`[data-testid="nec-export-${kind}"]`);
      await s.waitFor(() => typeof window.__necDownload === 'string');
      return s.page.evaluate(() => window.__necDownload);
    };
    const upload = async bytes => {
      const path = join(folder, 'wire.nec');
      writeFileSync(path, bytes);
      const chooser = s.page.waitForFileChooser();
      await s.page.click('[data-testid="nec-import"]');
      await (await chooser).accept([path]);
      await s.waitFor(() => !document.querySelector('[data-testid="nec-import"]').disabled);
    };
    const response = () => s.page.waitForResponse(r => new URL(r.url()).pathname === '/api/nec/transfer'
      && r.request().method() === 'POST');
    const unexpected = [];
    const observe = request => {
      if (request.method() === 'POST' && /\/api\/(?:runs|designs)(?:\/|$)/.test(new URL(request.url()).pathname))
        unexpected.push(request.url());
    };
    s.page.on('request', observe);
    let original, deck, imported;
    try {
      await s.step('create a separate wire dipole and export its exact model and deck', async () => {
        await s.page.goto(s.url, {waitUntil:'domcontentloaded'});
        await s.wait('.home');
        await s.page.evaluate(() => {
          const create = URL.createObjectURL.bind(URL);
          URL.createObjectURL = blob => {
            if (blob instanceof Blob) void blob.text().then(text => { window.__necDownload = text; });
            return create(blob);
          };
        });
        for (const selector of ['.antenna-calculator > summary', panel+' > summary']) {
          await s.page.focus(selector);
          await s.press('Enter');
        }
        await s.waitFor(() => !document.querySelector('[data-testid="nec-create"]').disabled);
        const ready = response();
        await s.page.click('[data-testid="nec-create"]');
        assert.equal((await ready).status(), 200);
        await s.wait('[data-testid="nec-summary"]');
        original = JSON.parse(await downloaded('record'));
        assert.equal(original.model.schema, 'fairbeam.nec/1');
        assert.equal(original.model.wires[0].segments, 31);
        assert.equal(original.model.wires[0].radius_mm, .05);
        assert.deepEqual(original.model.frequency_ghz, [2.45]);
        deck = await downloaded('deck');
        assert.equal(deck, original.deck);
        assert.equal(hash(deck), original.manifest.deck_sha256);
        assert.deepEqual(JSON.parse(await downloaded('model')), original.model);
      });
      await s.step('import UTF-8 BOM and CRLF without changing original source hash or model', async () => {
        const source = '\ufeff'+deck.replace(/\n/g, '\r\n');
        await upload(source);
        imported = JSON.parse(await downloaded('record'));
        assert.equal(imported.report.source_sha256, hash(source));
        assert.equal(imported.report.source_bytes, Buffer.byteLength(source));
        assert.equal(imported.report.solver_run, false);
        assert.equal(imported.report.numerically_validated, false);
        assert.equal(imported.deck, original.deck);
        assert.deepEqual(imported.model.feed, original.model.feed);
        assert.deepEqual(imported.model.frequency_ghz, original.model.frequency_ghz);
        // The deck has 12 significant digits; compare against its actual
        // coordinates rather than silently claiming lossless float64 export.
        const gw = deck.split('\n').find(line=>line.startsWith('GW ')).split(/\s+/).slice(1).map(Number);
        assert.deepEqual(imported.model.wires[0], {tag:gw[0],segments:gw[1],
          start_mm:gw.slice(2,5).map(x=>x*1000),end_mm:gw.slice(5,8).map(x=>x*1000),radius_mm:gw[8]*1000});
      });
      await s.step('unsupported ground and malformed UTF-8 preserve the last accepted model', async () => {
        for (const bad of [deck.replace('GN -1', 'GN 1'), Buffer.from([0xff])]) {
          await upload(bad);
          await s.wait(panel+' [role="alert"]');
          assert.deepEqual(JSON.parse(await downloaded('record')), imported);
        }
      });
      await s.step('invalid wire edits are refused; Cancel retains the model; valid edits revalidate it', async () => {
        await s.page.click('.nec-wire-table button');
        const fields = await s.page.$$('.nec-wire-editor input');
        await s.fill(fields[7], '100', {blur:false});
        let ready = response();
        await s.click('necTransfer.apply', {within:panel});
        assert.equal((await ready).status(), 422);
        await s.wait(panel+' [role="alert"]');
        await s.click('necTransfer.cancel', {within:panel});
        assert.deepEqual(JSON.parse(await downloaded('record')), imported);
        await s.page.click('.nec-wire-table button');
        await s.fill((await s.page.$$('.nec-wire-editor input'))[7], '.04', {blur:false});
        ready = response();
        await s.click('necTransfer.apply', {within:panel});
        assert.equal((await ready).status(), 200);
        await s.gone('.nec-wire-editor');
        const edited = JSON.parse(await downloaded('record'));
        assert.equal(edited.model.wires[0].radius_mm, .04);
        assert.equal(edited.report, null, 'the original source hash cannot describe edited geometry');
        assert.equal(hash(edited.deck), edited.manifest.deck_sha256);
      });
      await s.step('page a 26-wire model while every export retains all geometry', async () => {
        const wires = Array.from({length:26}, (_,i) => `GW ${i+1} 1 0 ${i/100} 0 0 ${i/100} .04 .00005`);
        const source = ['CM Numeric transfer fixture, not a solved antenna','CE',...wires,'GE 0','GN -1','EK 0',
          'EX 0 1 1 0 1 0','FR 0 1 0 0 300 0','XQ 0','EN',''].join('\n');
        await upload(source);
        assert.equal(await s.page.$$eval('.nec-wire-table tbody tr', rows=>rows.length), 25);
        await s.click('necTransfer.next', {within:panel});
        assert.equal(await s.page.$$eval('.nec-wire-table tbody tr', rows=>rows.length), 1);
        assert.equal(await s.page.$eval('.nec-wire-table tbody td', cell=>cell.textContent), '26');
        const record = JSON.parse(await downloaded('record'));
        assert.equal(record.model.wires.length, 26);
        assert.equal(record.report.source_sha256, hash(source));
        assert.equal((await downloaded('deck')).split('\n').filter(line=>line.startsWith('GW ')).length, 26);
        assert.equal(JSON.parse(await downloaded('model')).wires.length, 26);
        await s.click('necTransfer.previous', {within:panel});
        assert.equal(await s.page.$$eval('.nec-wire-table tbody tr', rows=>rows.length), 25);
        if (process.env.FAIRBEAM_SCENARIO_SCREENSHOTS) {
          mkdirSync(process.env.FAIRBEAM_SCENARIO_SCREENSHOTS, {recursive:true});
          for (const width of [1440, 390]) {
            await s.page.setViewport({width, height:900});
            await s.page.$eval(panel, element=>element.scrollIntoView());
            await s.page.screenshot({path:join(process.env.FAIRBEAM_SCENARIO_SCREENSHOTS, `S27-${s.lang}-${width}.png`)});
          }
          await s.page.setViewport({width:1440,height:900});
        }
      });
      await s.step('Cancel ignores a late edit response and stored exports remain available offline', async () => {
        const before = JSON.parse(await downloaded('record'));
        await s.page.click('.nec-wire-table button');
        await s.fill((await s.page.$$('.nec-wire-editor input'))[7], '.04', {blur:false});
        await s.ev((value,m)=>{
          const original=m.api.api.necTransfer;
          window.__necRestore=()=>{m.api.api.necTransfer=original;};
          m.api.api.necTransfer=body=>new Promise(resolve=>{
            window.__necRelease=()=>resolve({...value,model:body.model});
          });
        },before,{api:'/src/runner/api.ts'});
        try {
          await s.click('necTransfer.apply',{within:panel});
          await s.waitFor(()=>typeof window.__necRelease==='function');
          await s.click('necTransfer.cancel',{within:panel});
          await s.page.evaluate(async()=>{
            window.__necRelease();
            await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          });
          assert.deepEqual(JSON.parse(await downloaded('record')),before);
        } finally { await s.page.evaluate(()=>window.__necRestore()); }
        await s.ev((_,m)=>m.runner.setServerState('offline'),null,{runner:'/src/runner/store.ts'});
        try {
          assert.equal(await s.page.$eval('[data-testid="nec-import"]',button=>button.disabled),true);
          assert.deepEqual(JSON.parse(await downloaded('record')),before);
        } finally { await s.ev((_,m)=>m.runner.setServerState('online'),null,{runner:'/src/runner/store.ts'}); }
        assert.deepEqual(unexpected, [], 'transfers create no Design and submit no solver jobs');
      });
    } finally {
      s.page.off('request', observe);
      rmSync(folder, {recursive:true,force:true});
    }
  },
};
