#!/usr/bin/env node
/* CDP interaction test for the tools pages (index.html + export.html). */
const { spawn } = require('child_process');

const BASE = process.env.TOOLS_URL || 'file:///home/lee/Documents/projects/veerastich-tools/';

// pick a port that is actually free (stale chromes from crashed runs may hold one)
async function freePort() {
  for (let i = 0; i < 20; i++) {
    const port = 9400 + Math.floor(Math.random() * 300);
    try {
      await fetch(`http://localhost:${port}/json`, { signal: AbortSignal.timeout(300) });
      // something answered — occupied
    } catch {
      return port; // connection refused / timeout -> free
    }
  }
  throw new Error('no free port found');
}

async function main() {
  const PORT = await freePort();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

setTimeout(() => { console.error('TIMEOUT after 90s'); process.exit(1); }, 90000).unref();

  const chrome = spawn('google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--allow-file-access-from-files',
    `--remote-debugging-port=${PORT}`, BASE + 'index.html',
  ], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
      target = list.find(t => t.type === 'page' && t.url.startsWith('file:'));
      if (target) break;
    } catch { /* booting */ }
    await sleep(250);
  }
  if (!target) throw new Error('no CDP target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push((m.params.exceptionDetails.exception || {}).description || 'exception');
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(m.params.type)) {
      pageErrors.push(m.params.args.map(a => a.value || a.description || '').join(' '));
    }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };
  await new Promise(r => ws.onopen = r);

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval threw: ' + (r.exceptionDetails.exception || {}).description);
    return r.result.value;
  };
  const sleepMs = sleep;

  const results = [];
  const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);

  await sleepMs(1200);
  console.log('STEP: page1 loaded');

  // ===== page 1: index.html =====
  check('page1 RTL', await evalJs(`document.documentElement.dir`) === 'rtl');
  check('page1 RTL', await evalJs(`document.documentElement.dir`) === 'rtl');
  const bgStyle = await evalJs(`getComputedStyle(document.querySelector('.bg')).backgroundImage`);
  check('page1 bg hero image', bgStyle.includes('hero-bg.jpg'), bgStyle.slice(0, 60));


  console.log('STEP: hints test');
  // page1 requirements: no open button, copy at start, no inter-links, RTL placeholders
  check('no open button', await evalJs(`!document.getElementById('b-open')`));
  check('copy button at start', await evalJs(`getComputedStyle(document.querySelector('.actions')).justifyContent`) === 'normal');
  check('no inter-links', await evalJs(`document.querySelectorAll('nav.pages').length === 0 && !document.body.textContent.includes('המרת CSV')`));
  check('phone field rtl', await evalJs(`getComputedStyle(document.getElementById('f-phone')).direction`) === 'rtl');
  check('phone value stays ltr (plaintext)', await evalJs(`getComputedStyle(document.getElementById('f-phone')).unicodeBidi`) === 'plaintext');
  check('linkout rtl when empty', await evalJs(`document.getElementById('f-link').getAttribute('dir')`) === 'rtl');

  // invalid input -> hints
  await evalJs(`document.getElementById('b-copy').click()`);
  await sleepMs(150);
  check('empty -> name hint', await evalJs(`document.getElementById('hint-name').classList.contains('show')`));
  check('empty -> no link', await evalJs(`document.getElementById('f-link').value`) === '');

  console.log('STEP: link test');
  // valid input -> link + copy
  await evalJs(`
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('f-name', 'אבי ישראלי');
    set('f-phone', '050-1234567');
  `);
  await evalJs(`document.getElementById('b-copy').click()`);
  await sleepMs(200);
  const link = await evalJs(`document.getElementById('f-link').value`);
  check('link prefilled', link.includes('entry.1659420434=%D7%90%D7%91%D7%99%20%D7%99%D7%A9%D7%A8%D7%90%D7%9C%D7%99') &&
    link.includes('entry.632618070=050-1234567'), link.slice(-80));
  check('copy toast', await evalJs(`document.getElementById('toast').hidden`) === false);
  check('linkout ltr after copy', await evalJs(`document.getElementById('f-link').getAttribute('dir')`) === 'ltr');

  console.log('STEP: navigating to export');
  // ===== page 2: export.html =====
  await send('Page.navigate', { url: BASE + 'export/index.html' });
  await sleepMs(1000);
  check('page2 RTL', await evalJs(`document.documentElement.dir`) === 'rtl');
  check('paste rtl when empty', await evalJs(`document.getElementById('f-paste').getAttribute('dir')`) === 'rtl');

  console.log('STEP: sample');
  // load sample
  await evalJs(`document.getElementById('b-sample').click()`);
  await sleepMs(300);
  check('3 cards', await evalJs(`document.getElementById('counter').textContent`) === '1 / 3');
  const card1 = await evalJs(`document.getElementById('card').textContent`);
  check('card1 title', card1.startsWith('✨ ישראל ישראלי ✨'));
  check('card1 fields aligned', card1.includes('🏡 מגורים:\nירושלים') && card1.includes('🎓 עיסוק:\nסטודנט להנדסה'));
  check('card1 split range', card1.includes('🎯 מה אני מחפש:\nבחורה רצינית') && card1.includes('טווח גילאים:\nבת 22-27'));
  check('status ok', (await evalJs(`document.getElementById('status').textContent`)).includes('3 כרטיסים נוצרו'));
  check('paste ltr after load', await evalJs(`document.getElementById('f-paste').getAttribute('dir')`) === 'ltr');
  check('panel visible', await evalJs(`!document.getElementById('carousel-panel').hidden`));

  console.log('STEP: keyboard');
  // keyboard nav: ArrowLeft = next (RTL), ArrowRight = prev
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))`);
  await sleepMs(150);
  check('arrow left -> next', await evalJs(`document.getElementById('counter').textContent`) === '2 / 3');
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))`);
  await sleepMs(150);
  check('arrow right -> prev', await evalJs(`document.getElementById('counter').textContent`) === '1 / 3');

  console.log('STEP: layout');
  // layout: buttons flank the counter; card is a full-width sibling below
  check('counter between buttons', await evalJs(`(function(){
    const row = document.querySelector('.crow');
    const kids = [...row.children].map(c => c.id);
    return kids.join(',') === 'b-prev,counter,b-next';
  })()`));
  check('card below the row', await evalJs(`document.querySelector('.car').children[1].id`) === 'card');
  check('card no border', await evalJs(`getComputedStyle(document.getElementById('card')).borderTopWidth`) === '0px');
  check('card subtle bg', await evalJs(`getComputedStyle(document.getElementById('card')).backgroundColor`) === 'rgb(245, 249, 253)');
  check('card shadow', await evalJs(`parseFloat(getComputedStyle(document.getElementById('card')).boxShadow.split(' ')[2]) > 10`));

  check('layout card = card 1', card1.startsWith('✨ ישראל ישראלי ✨'));
  await evalJs(`document.getElementById('b-next').click()`);
  await sleepMs(150);
  check('next button', await evalJs(`document.getElementById('counter').textContent`) === '2 / 3');
  const card2 = await evalJs(`document.getElementById('card').textContent`);
  check('card2 multiline+split', card2.includes('🧍‍♂️ קצת עלי:\nמחפש בחורה טובה\nעם מידות טובות') &&
    card2.includes('טווח גילאים:\n24-28'));
  await evalJs(`document.getElementById('b-next').click()`);
  await sleepMs(150);
  check('prev enabled at 3/3', await evalJs(`!document.getElementById('b-prev').disabled`));
  check('next disabled at end', await evalJs(`document.getElementById('b-next').disabled`));

  console.log('STEP: copy');
  // copy current card (button + c shortcut)
  await evalJs(`document.getElementById('b-copy1').click()`);
  await sleepMs(200);
  check('copy toast', await evalJs(`document.getElementById('toast').hidden`) === false);
  await evalJs(`document.getElementById('b-prev').click()`); // back to 2/3
  await sleepMs(120);
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }))`);
  await sleepMs(200);
  check('c copies current card', await evalJs(`document.getElementById('toast').hidden`) === false);
  check('still on 2/3 after c', await evalJs(`document.getElementById('counter').textContent`) === '2 / 3');

  // copy all -> full txt with 3 blank lines between cards
  const all = await evalJs(`Tools.joinCards(Tools.parseAll(Tools.SAMPLE_CSV).cards)`);
  check('copy all text', typeof all === 'string' && all.includes('✨ משה כהן ✨') && all.split('✨').length >= 7);
  check('3 blank lines between cards', all.indexOf('050-4444444') !== -1 &&
    all.indexOf('050-4444444\n\n\n✨') !== -1);

  // download button exists
  check('download button', await evalJs(`!!document.getElementById('b-download')`));

  // ===== no page errors =====
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));

  console.log(results.join('\n'));
  console.log(`\n${results.filter(r => r.startsWith('PASS')).length}/${results.length} passed`);
  chrome.kill();
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
