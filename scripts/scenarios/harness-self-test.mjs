import assert from 'node:assert/strict';
import { Session } from './harness.mjs';

/** Exercise real pointer clicks against moving and replaced nodes, without the application. */
export async function interactionSelfTest(page) {
  const s = new Session(page, { lang: 'tr', scenario: 'self-test', url: 'about:blank' });
  s.T = async key => key;
  await page.setContent(`<body><div class="scope"><button>Çalıştır</button></div>
    <div class="scope"><button style="display:none">Çalıştır</button>
    <button title="Çalıştır">Topmost target</button><button>Çalıştır sonra</button></div></body>`);
  await page.evaluate(() => {
    window.__clicks = [];
    document.querySelectorAll('button').forEach(e => e.onclick = () => window.__clicks.push(e.textContent));
  });
  await s.click('Çalıştır', { within: '.scope', exact: true });
  assert.deepEqual(await page.evaluate(() => window.__clicks), ['Topmost target'], 'exact matching, hidden controls and topmost scope');

  await page.setContent('<body><button disabled>Saved</button></body>');
  await page.evaluate(() => {
    window.__clicks = [];
    document.querySelector('button').onclick = () => window.__clicks.push('disabled');
  });
  await s.click('Saved', { sel: 'button', exact: true });
  assert.deepEqual(await page.evaluate(() => window.__clicks), [], 'disabled controls retain their no-op pointer behavior');

  await page.setContent('<body><button id="moving" style="position:absolute;left:10px;top:10px">Move</button></body>');
  await page.evaluate(() => {
    const button = document.querySelector('#moving');
    window.__moves = 0; window.__clickedAt = null;
    button.onclick = () => { window.__clickedAt = window.__moves; };
    const move = () => {
      button.style.left = `${10 + ++window.__moves * 20}px`;
      if (window.__moves < 12) requestAnimationFrame(move);
    };
    requestAnimationFrame(move);
  });
  await s.clickSel('#moving');
  assert.equal(await page.evaluate(() => window.__clickedAt), 12, 'click waits for the moving target to settle');

  await page.setContent('<body><button>Replace</button></body>');
  await page.evaluate(() => {
    window.__clicks = [];
    const root = document.body, query = root.querySelectorAll.bind(root);
    let replaced = false;
    root.querySelectorAll = selector => {
      const result = query(selector);
      if (!replaced && selector === 'button') {
        replaced = true;
        queueMicrotask(() => {
          const next = result[0].cloneNode(true);
          next.onclick = () => window.__clicks.push('replacement');
          result[0].replaceWith(next);
        });
      }
      return result;
    };
  });
  await s.click('Replace', { sel: 'button', exact: true });
  assert.deepEqual(await page.evaluate(() => window.__clicks), ['replacement'], 'reacquires the node replaced after lookup');
  await assert.rejects(s.clickSel('#missing-control', { timeout: 150 }), /click #missing-control in body:.*Timed out/, 'missing controls still fail with the target in the diagnostic');
}
