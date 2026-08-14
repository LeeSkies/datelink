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
    '--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=1440,900',
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
  check('no linkout box', await evalJs(`!document.getElementById('f-link')`));

  // invalid input -> hints
  await evalJs(`document.getElementById('b-copy').click()`);
  await sleepMs(150);
  check('empty -> name hint', await evalJs(`document.getElementById('hint-name').classList.contains('show')`));
  check('share note shown', await evalJs(`document.querySelector('.share-note') && document.querySelector('.share-note').textContent.includes('ישיבות הסדר')`));

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
  const link = await evalJs(`Tools.buildShareUrl('אבי ישראלי', '050-1234567')`);
  check('link prefilled as short /sh link', link.includes('/sh/index.html?n=~abj+jutalj&n=~AFABCDEFGH') && !/\d/.test(link) && link.indexOf('entry.') === -1 && link.indexOf('docs.google.com') === -1, link.slice(-80));
  check('copy toast', await evalJs(`document.getElementById('toast').hidden`) === false);

  // /sh redirect: valid details -> the prefilled form; missing -> back to the generator
  await send('Page.navigate', { url: BASE + 'sh/index.html?n=' + encodeURIComponent('אבי ישראלי') + '&n=' + encodeURIComponent('050-1234567') });
  await sleepMs(1500);
  const shTarget = await evalJs(`location.href`);
  // headless Google may bounce to a sign-in URL, but the prefilled form link
  // (with both entries) must be the destination either way
  check('sh redirects to the prefilled form', shTarget.indexOf('viewform') !== -1 && shTarget.indexOf('entry.1659420434') !== -1 && shTarget.indexOf('entry.632618070') !== -1 && shTarget.indexOf('050-1234567') !== -1, shTarget.slice(0, 120));
  // encoded links (the new format): decode back to Hebrew before redirecting
  await send('Page.navigate', { url: BASE + 'sh/index.html?n=~abj+tfx&n=~AFABCDEFGH' });
  await sleepMs(1500);
  const shEnc = await evalJs(`location.href`);
  check('sh decodes the letter code into the form link', shEnc.indexOf('viewform') !== -1 && shEnc.indexOf('entry.1659420434') !== -1 && (shEnc.indexOf('%D7%90%D7%91%D7%99%20%D7%A8%D7%95%D7%9F') !== -1 || shEnc.indexOf('%25D7%2590%25D7%2591%25D7%2599') !== -1), shEnc.slice(0, 120));
  await send('Page.navigate', { url: BASE + 'sh/index.html' });
  await sleepMs(1000);
  check('sh without details goes back to the generator', await evalJs(`location.href.includes('index.html') && !location.href.includes('docs.google.com')`), await evalJs(`location.href`));

  // share handlers: copy carries the full message; whatsapp opens wa.me with it;
  // system share hides itself without the Web Share API
  check('share + whatsapp buttons present', await evalJs(`!!document.getElementById('b-share') && !!document.getElementById('b-whatsapp')`));
  check('icons render at full size', await evalJs(`(() => { const ss = [...document.querySelectorAll('.btn.icon-btn svg')].map(s => getComputedStyle(s)); return ss.length === 2 && ss.every(s => s.width === '20px' && s.height === '20px' && s.fill === 'rgb(255, 255, 255)'); })()`));
  check('icon buttons match the copy button height', await evalJs(`(() => { const h = document.getElementById('b-copy').getBoundingClientRect().height; return [...document.querySelectorAll('.btn.icon-btn')].filter(b => !b.hidden).every(b => Math.abs(b.getBoundingClientRect().height - h) < 1); })()`));
  check('icon buttons stay square (width = height)', await evalJs(`(() => { const r = [...document.querySelectorAll('.btn.icon-btn')].filter(b => !b.hidden).map(b => b.getBoundingClientRect()); return r.length > 0 && r.every(x => Math.abs(x.width - x.height) < 1); })()`));
  // the sh redirect tests above left us on a fresh index page — fill it again
  await evalJs(`(() => { const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }; set('f-name', 'אבי ישראלי'); set('f-phone', '050-1234567'); })()`);
  await evalJs(`window.__copied = null; window.Tools.copyText = function (t) { window.__copied = t; return Promise.resolve(true); }; window.__opened = null; window.open = function (u) { window.__opened = u; return null; };`);
  await evalJs(`document.getElementById('b-copy').click()`);
  await sleepMs(150);
  check('copy carries the share message with link', await evalJs(`window.__copied && window.__copied.indexOf('*מיזם השידוכים וְאֵרַשְׂתִּיךְ💍*') === 0 && window.__copied.indexOf('לחצו על הקישור:') !== -1 && window.__copied.trim().endsWith(${JSON.stringify(link)})`));
  check('whatsapp opens wa.me with the encoded text', await evalJs(`(() => { document.getElementById('b-whatsapp').click(); return window.__opened && window.__opened.indexOf('https://wa.me/?text=') === 0 && decodeURIComponent(window.__opened).indexOf('לחצו על הקישור:') !== -1 && decodeURIComponent(window.__opened).indexOf('/sh/index.html?n=') !== -1 && decodeURIComponent(window.__opened).indexOf('entry.') === -1; })()`));
  check('system share hidden without Web Share API', await evalJs(`document.getElementById('b-share').hidden`));
  // with the Web Share API present the button shows and hands the message to it
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__injRan = true; try { Object.defineProperty(navigator, 'share', { value: function (d) { window.__shared = d; return Promise.resolve(); }, configurable: true }); } catch (e) { window.__injErr = String(e); }` });
  await send('Page.navigate', { url: BASE + 'index.html' });
  await sleepMs(800);
  check('share button visible with Web Share API', await evalJs(`!document.getElementById('b-share').hidden`));
  await evalJs(`(() => { const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }; set('f-name', 'אבי ישראלי'); set('f-phone', '050-1234567'); })()`);
  await evalJs(`document.getElementById('b-share').click()`);
  await sleepMs(150);
  check('share dialog receives the message with link', await evalJs(`window.__shared && window.__shared.text.indexOf('*מיזם השידוכים וְאֵרַשְׂתִּיךְ💍*') === 0 && window.__shared.text.indexOf('לחצו על הקישור:') !== -1 && window.__shared.text.trim().endsWith(${JSON.stringify(link)})`));

  console.log('STEP: navigating to export');
  // ===== page 2: export.html =====
  await send('Page.navigate', { url: BASE + 'export/index.html' });
  await sleepMs(1000);
  check('page2 RTL', await evalJs(`document.documentElement.dir`) === 'rtl');
  check('paste rtl when empty', await evalJs(`document.getElementById('f-paste').getAttribute('dir')`) === 'rtl');
  check('tabs show (0) by default', await evalJs(`document.getElementById('tab-3').textContent === '3 כרטיסים ומטה (0)' && document.getElementById('tab-4').textContent === '4 כרטיסים ומעלה (0)' && document.getElementById('group-out').hidden`));

  console.log('STEP: sample');
  // load sample
  await evalJs(`document.getElementById('b-sample').click()`);
  await sleepMs(300);
  check('3 cards', await evalJs(`document.getElementById('counter').textContent`) === '1 / 3');
  const card1 = await evalJs(`document.getElementById('card').textContent`);
  check('card1 title', card1.startsWith('✨ ישראל ישראלי ✨'));
  check('card1 fields bold-marked', await evalJs(`(() => { const c = document.getElementById('card'); return c.innerHTML.includes('<b>גיל</b>') && c.innerHTML.includes('<b>🎓 עיסוק:</b>') && !c.textContent.includes('*'); })()`));
  check('copy text carries bold markers', await evalJs(`(() => { const t = Tools.buildCard({ name: 'א', age: '22', origin: 'עדה מזרחית' }); return t.includes('*גיל*: 22') && t.includes('*👳🏻 עדה, רקע משפחתי:*\\nעדה מזרחית') && t.includes('*🎯 מה אני מחפש*') === false; })()`));
  check('card1 fields aligned', card1.includes('🏡 מגורים:\nירושלים') && card1.includes('🎓 עיסוק:\nסטודנט להנדסה'));
  check('card1 combined looking block', card1.includes('🎯 מה אני מחפש + טווח גילאים:\nבחורה רצינית בת 22-27') && card1.includes('*🎯 מה אני מחפש:*') === false);
  check('card1 personal phone block', card1.includes('מספר טלפון אישי (המספר לא יפורסם באתר):\n050-2222222'));
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
  check('card2 multiline+combined', card2.includes('🧍‍♂️ קצת עלי:\nמחפש בחורה טובה\nעם מידות טובות') &&
    card2.includes('🎯 מה אני מחפש + טווח גילאים:\nמחפש בחורה רצינית\nטווח גילאים: 24-28') &&
    card2.includes('מספר טלפון אישי (המספר לא יפורסם באתר):\n050-5555555'));
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
  check('copy all text', typeof all === 'string' && all.includes('*✨ משה כהן ✨*') && all.includes('*🎓 עיסוק:*') && all.split('✨').length >= 7);
  check('3 blank lines between cards', all.indexOf('050-5555555') !== -1 &&
    all.indexOf('050-5555555\n\n\n*✨') !== -1);

  // download button exists
  check('download button', await evalJs(`!!document.getElementById('b-download')`));

  console.log('STEP: photos from sheet links');
  // unit: extract Drive file IDs from open?id= and /file/d/ links
  check('extract open?id', await evalJs(`Tools.extractFileIds('https://drive.google.com/open?id=Abc1234567890XyZ-_Qwerty')[0]`) === 'Abc1234567890XyZ-_Qwerty');
  check('extract file/d', await evalJs(`Tools.extractFileIds('https://drive.google.com/file/d/Def9876543210Uiop-_-Lkjhg/view?usp=sharing')[0]`) === 'Def9876543210Uiop-_-Lkjhg');
  check('extract two links from one cell', await evalJs(`Tools.extractFileIds('a: https://drive.google.com/open?id=Abc1234567890XyZ-_Qwerty, https://drive.google.com/file/d/Def9876543210Uiop-_-Lkjhg/view').join(',')`) === 'Abc1234567890XyZ-_Qwerty,Def9876543210Uiop-_-Lkjhg');
  check('extract empty cell', await evalJs(`Tools.extractFileIds('').length`) === 0);
  check('thumbUrl builder', await evalJs(`Tools.thumbUrl('Xx12345678901234567890')`) === 'https://drive.google.com/thumbnail?id=Xx12345678901234567890&sz=w800');
  // parseAll attaches photos per card
  const parsed = await evalJs(`Tools.parseAll(Tools.SAMPLE_CSV)`);
  check('card 2 has 2 photos', parsed.cards[1].images.length === 2);
  check('card 1 has 0 photos', parsed.cards[0].images.length === 0);
  check('card text has no links', !parsed.cards[1].text.includes('drive.google'));
  check('cardWithImages appends links', await evalJs(`Tools.cardWithImages(Tools.parseAll(Tools.SAMPLE_CSV).cards[1]).includes('🖼️ תמונה: https://drive.google.com/open?id=Abc1234567890XyZ-_Qwerty')`));
  check('exportAllText includes links', await evalJs(`Tools.exportAllText(Tools.parseAll(Tools.SAMPLE_CSV).cards).includes('Def9876543210Uiop-_-Lkjhg')`));
  check('downloadUrl builder', await evalJs(`Tools.downloadUrl('Xx12345678901234567890')`) === 'https://drive.google.com/uc?export=download&id=Xx12345678901234567890');
  // browser: open/download buttons instead of rendered images
  await evalJs(`localStorage.removeItem('datelink-export-idx:sample')`); // deterministic start
  await evalJs(`document.getElementById('b-sample').click()`);
  await sleepMs(200);
  await evalJs(`document.getElementById('b-next').click()`); // card 2 (has photos)
  await sleepMs(200);
  check('2 photo button groups on card 2', await evalJs(`document.querySelectorAll('#card-imgs .photo').length`) === 2);
  check('open button href', await evalJs(`document.querySelector('#card-imgs .photo a').getAttribute('href')`) === 'https://drive.google.com/open?id=Abc1234567890XyZ-_Qwerty');
  check('download button href', await evalJs(`document.querySelector('#card-imgs .photo a:nth-child(2)').getAttribute('href')`) === 'https://drive.google.com/uc?export=download&id=Abc1234567890XyZ-_Qwerty');
  check('buttons open in new tab', await evalJs(`document.querySelector('#card-imgs .photo a').getAttribute('target')`) === '_blank');
  await evalJs(`document.getElementById('b-prev').click()`); // card 1 (no photos)
  await sleepMs(200);
  check('no buttons on card without photos', await evalJs(`document.querySelectorAll('#card-imgs .photo').length`) === 0);
  await evalJs(`document.getElementById('b-next').click()`);
  await sleepMs(200);
  check('img container after card', await evalJs(`document.querySelector('.car').children[1].id`) === 'card' && await evalJs(`document.querySelector('.car').children[2].id`) === 'card-imgs');

  console.log('STEP: localStorage position');
  // navigating saves the position under the current file name; reloading the
  // page does NOT restore data — only a same-named file gets its position back
  await evalJs(`document.getElementById('b-next').click()`); // 2/3 -> 3/3
  await sleepMs(150);
  check('idx saved under sample key', await evalJs(`localStorage.getItem('datelink-export-idx:sample')`) === '2');
  check('no csv persisted', await evalJs(`localStorage.getItem('datelink-export-csv')`) === null);
  await evalJs(`location.reload()`);
  await sleepMs(2000);
  check('reload starts empty', await evalJs(`document.getElementById('counter').textContent`) === '');
  await evalJs(`document.getElementById('b-sample').click()`); // same key 'sample' again
  await sleepMs(200);
  check('same file name restores position', await evalJs(`document.getElementById('counter').textContent`) === '3 / 3');
  // a fresh load (paste — no file name) starts at card 1 again
  await evalJs(`document.getElementById('f-paste').value = Tools.SAMPLE_CSV; document.getElementById('f-paste').dispatchEvent(new Event('input'));`);
  await sleepMs(300);
  check('fresh load starts at 1', await evalJs(`document.getElementById('counter').textContent`) === '1 / 3');

  console.log('STEP: search & filter');
  // unit: phone normalization (keys only — display stays as typed)
  check('norm strips dashes/spaces', await evalJs(`Tools.normPhone('050-333 4166')`) === '0503334166');
  check('norm +972 prefix', await evalJs(`Tools.normPhone('+972-50-333-4166')`) === '0503334166');
  check('norm bare 972 prefix', await evalJs(`Tools.normPhone('972503334166')`) === '0503334166');
  check('norm 00 prefix', await evalJs(`Tools.normPhone('00972503334166')`) === '0503334166');
  check('norm leaves plain number', await evalJs(`Tools.normPhone('0503334166')`) === '0503334166');
  check('norm empty', await evalJs(`Tools.normPhone('')`) === '');
  // formatted variants of the same number collapse into one key
  const fmtCsv = [
    'שם + שם משפחה:,גיל:,מה אני מחפש+ טווח גילאים:,מספר פלאפון לברורים ויצירת קשר:,מספר פלאפון אישי שלך: (לא יפורסם ),צירוף תמונה עדכנית:,הגעתי דרך:,שם מלא:,מספר פלאפון:,חותמת זמן',
    'אבי,25,בחורה רצינית,050-1,050-2,,קבוצה,מיכל,050-9,2026-01-01 10:00:00',
    'בועז,27,בחורה טובה,0501,0502,,אתר,מיכל,+972509,2026-01-02 10:00:00',
    'גיל,28,מחפש שידוך,050-5,050-5,,קבוצה,מיכל,0509,2026-01-03 10:00:00'
  ].join('\n');
  check('formatted ref variants = one referee', await evalJs(`Tools.refereeStats(Tools.parseAll(${JSON.stringify(fmtCsv)}).cards).length`) === 1);
  check('first display phone kept', await evalJs(`Tools.refereeStats(Tools.parseAll(${JSON.stringify(fmtCsv)}).cards)[0].phone`) === '050-9');
  check('formatted personal variants collapse into one card', await evalJs(`Tools.refereeStats(Tools.parseAll(${JSON.stringify(fmtCsv)}).cards)[0].count`) === 2);
  // unit: referee stats + dedup by personal number
  check('sample refs extracted', await evalJs(`JSON.stringify(Tools.parseAll(Tools.SAMPLE_CSV).cards[0].ref)`) === '{"name":"אבי ישראלי","phone":"050-3333333"}');
  check('filter 1+ -> 3 names', await evalJs(`Tools.filterReferees(Tools.parseAll(Tools.SAMPLE_CSV).cards, 1).join(',')`) === 'אבי ישראלי,יצחק כהן,שמעון לוי');
  check('filter 2+ -> empty', await evalJs(`Tools.filterReferees(Tools.parseAll(Tools.SAMPLE_CSV).cards, 2).length`) === 0);
  // browser: paste a csv with a referee holding 2 distinct candidates
  const refCsv = [
    'שם + שם משפחה:,גיל:,מה אני מחפש+ טווח גילאים:,מספר פלאפון לברורים ויצירת קשר:,מספר פלאפון אישי שלך: (לא יפורסם ),צירוף תמונה עדכנית:,הגעתי דרך:,שם מלא:,מספר פלאפון:,חותמת זמן',
    'אבי,25,בחורה רצינית,050-1,050-2,,קבוצה,מיכל,050-9,2026-01-01 10:00:00',
    'בועז,27,בחורה טובה,050-1,050-2,,אתר,מיכל,050-9,2026-01-02 10:00:00', // same PERSONAL phone -> same card, deduped
    'גיל,28,מחפש שידוך,050-5,050-6,,קבוצה,מיכל,050-9,2026-01-03 10:00:00',
    'דוד,29,בחורה,050-7,050-2,,אתר,מיכל,050-8,2026-01-04 10:00:00' // same personal, other ref phone -> separate referee
  ].join('\n');
  await evalJs(`document.getElementById('f-paste').value = ${JSON.stringify(refCsv)}; document.getElementById('f-paste').dispatchEvent(new Event('input'));`);
  await sleepMs(300);
  check('card phone attached', await evalJs(`Tools.parseAll(document.getElementById('f-paste').value).cards[0].phone`) === '050-1');
  check('card personal phone attached', await evalJs(`Tools.parseAll(document.getElementById('f-paste').value).cards[0].personal`) === '050-2');
  check('same candidate twice counts once', await evalJs(`Tools.refereeStats(Tools.parseAll(document.getElementById('f-paste').value).cards)[0].count`) === 2);
  check('same name different ref phone = separate referee', await evalJs(`Tools.filterReferees(Tools.parseAll(document.getElementById('f-paste').value).cards, 1).filter(n => n === 'מיכל').length`) === 2);

  console.log('STEP: roulette groups');
  // referees with 2..5 cards: א=2, ב=3, ג=4, ד=5
  const GROUP_HEADER = 'שם + שם משפחה:,גיל:,מה אני מחפש+ טווח גילאים:,מספר פלאפון לברורים ויצירת קשר:,מספר פלאפון אישי שלך: (לא יפורסם ),צירוף תמונה עדכנית:,הגעתי דרך:,שם מלא:,מספר פלאפון:,חותמת זמן';
  function groupCsv() {
    const refs = [['א', '050-1'], ['ב', '050-2'], ['ג', '050-3'], ['ד', '050-4']];
    const lines = [GROUP_HEADER];
    let row = 1;
    refs.forEach(([nm, refPhone], ri) => {
      for (let k = 0; k < ri + 2; k++) {
        lines.push(`מועמד${ri}-${k},25,בחורה רצינית,050-${10 + row++},050-${50 + row++},,קבוצה,${nm},${refPhone},2026-01-01 10:00:00`);
      }
    });
    return lines.join('\n');
  }
  const gc = groupCsv();
  check('group 3 ומטה = ב,א (count desc)', await evalJs(`Tools.filterReferees(Tools.parseAll(${JSON.stringify(gc)}).cards, 1, 3).join(',')`) === 'ב,א');
  check('group 4 ומעלה = ד,ג', await evalJs(`Tools.filterReferees(Tools.parseAll(${JSON.stringify(gc)}).cards, 4, '').join(',')`) === 'ד,ג');
  check('group objects carry the ref phone', await evalJs(`JSON.stringify(Tools.filterRefereeGroups(Tools.parseAll(${JSON.stringify(gc)}).cards, 1, 3))`) === '[{"name":"ב","phone":"050-2","count":3},{"name":"א","phone":"050-1","count":2}]');
  check('share text template', await evalJs(`Tools.buildShareText('https://x.test/l')`) === '*מיזם השידוכים וְאֵרַשְׂתִּיךְ💍*\n*מיועד לבחורים מהמגזר הדתי־לאומי תורני.*\n\n*להצטרפות למיזם לחצו על הקישור:*\nhttps://x.test/l');
  check('share url short form (https)', await evalJs(`Tools.buildShareUrl('אבי ישראלי', '050-1234567', 'https://leeskies.github.io/datelink/index.html')`) === 'https://leeskies.github.io/datelink/sh?n=~abj+jutalj&n=~AFABCDEFGH');
  check('share url short form (dir root)', await evalJs(`Tools.buildShareUrl('א', '0501234567', 'https://leeskies.github.io/datelink/')`) === 'https://leeskies.github.io/datelink/sh?n=~a&n=~AFABCDEFGH');
  check('share url short form (file:)', await evalJs(`Tools.buildShareUrl('א', '0501234567', 'file:///a/tools/index.html')`) === 'file:///a/tools/sh/index.html?n=~a&n=~AFABCDEFGH');
  check('no digits in the share link', await evalJs(`!/\\d/.test(Tools.buildShareUrl('אבי רון', '050-1234567', 'https://leeskies.github.io/datelink/'))`));
  check('codec round trip (letters+finals+digits)', await evalJs(`Tools.decodeText(Tools.encodeText('שמואל כהן םןצףך 123')) === 'שמואל כהן םןצףך 123'`));
  check('codec specific codes', await evalJs(`Tools.encodeText('אבי רון') === 'abj+tfx' && Tools.decodeText('tfx') === 'רון' && Tools.decodeText('aa') === 'ך' && Tools.decodeText('ABC') === '012'`));
  check('legacy params pass through', await evalJs(`Tools.decodedParam('אבי רון') === 'אבי רון' && Tools.decodedParam('050-1234567') === '050-1234567'`));
  check('marked params decode', await evalJs(`Tools.decodedParam('~abj+tfx') === 'אבי רון' && Tools.decodedParam('~AFABCDEFGH') === '0501234567'`));
  check('boys form link uses boys entries', await evalJs(`Tools.buildFormLink('א', '0501234567', 'boys')`) === 'https://docs.google.com/forms/d/e/1FAIpQLSdYrIxaJ9skefLmWb9z04qVt2K-UP4XiO1DdumDMbJ3PsguHQ/viewform?usp=pp_url&entry.885956976=%D7%90&entry.488453562=0501234567');
  check('girls default keeps old entries', await evalJs(`Tools.buildFormLink('א', '0501234567')`) === 'https://docs.google.com/forms/d/e/1FAIpQLScFmbqLvxsIgdu0fqneZyuifsGFQ-wY00LB15CY4B4NRIHSbA/viewform?usp=pp_url&entry.1659420434=%D7%90&entry.632618070=0501234567');
  check('boys share url goes to /sh/b', await evalJs(`Tools.buildShareUrl('א', '0501234567', 'https://leeskies.github.io/datelink/', 'boys')`) === 'https://leeskies.github.io/datelink/sh/b?n=~a&n=~AFABCDEFGH');
  check('boys share url file: variant', await evalJs(`Tools.buildShareUrl('א', '0501234567', 'file:///a/tools/b/index.html', 'boys')`) === 'file:///a/tools/sh/b/index.html?n=~a&n=~AFABCDEFGH');
  // browser: default tab-3 shows its names automatically after paste
  await evalJs(`document.getElementById('f-paste').value = ${JSON.stringify(gc)}; document.getElementById('f-paste').dispatchEvent(new Event('input'));`);
  await sleepMs(300);
  check('default tab-3 active, names shown (no click)', await evalJs(`document.getElementById('tab-3').classList.contains('active') && document.getElementById('tab-3').textContent === '3 כרטיסים ומטה (2)' && !document.getElementById('group-out').hidden && document.getElementById('group-list').textContent === 'ב (3), א (2)'`));
  check('head line hidden when names exist', await evalJs(`document.getElementById('group-head').hidden`));
  // switch to tab-4
  await evalJs(`document.getElementById('tab-4').click()`);
  await sleepMs(200);
  check('tab-4 (2) active with 4+ names', await evalJs(`document.getElementById('tab-4').classList.contains('active') && document.getElementById('tab-4').textContent === '4 כרטיסים ומעלה (2)' && document.getElementById('group-list').textContent === 'ד (5), ג (4)'`));
  check('tab-3 also shows its count', await evalJs(`document.getElementById('tab-3').textContent === '3 כרטיסים ומטה (2)'`));
  check('tab-3 no longer active', await evalJs(`!document.getElementById('tab-3').classList.contains('active')`));
  // back to tab-3 and open the roulette as a full-page overlay
  await evalJs(`document.getElementById('tab-3').click()`);
  await sleepMs(200);
  await evalJs(`document.getElementById('b-to-roulette').click()`);
  await sleepMs(900);
  check('overlay opened over the ui', await evalJs(`!document.getElementById('roulette-overlay').hidden`));
  check('iframe src has no names', await evalJs(`(() => { const u = new URL(document.getElementById('roulette-frame').src); return u.searchParams.get('names') === null && u.searchParams.get('embed') === '1'; })()`));
  check('names arrived in the wheel (postMessage)', await evalJs(`(() => { const d = document.getElementById('roulette-frame').contentDocument; return d && d.getElementById('spinBtn') && !d.getElementById('spinBtn').disabled; })()`));
  check('wheel payload keeps ref phones (localStorage courtesy)', await evalJs(`(() => { try { const v = JSON.parse(localStorage.getItem('datelink-roulette-names')); return Array.isArray(v) && v.length === 2 && v.every(x => typeof x.name === 'string' && typeof x.phone === 'string' && x.phone.length > 0); } catch (e) { return false; } })()`));
  check('side names list hidden inside frame', await evalJs(`(() => { const d = document.getElementById('roulette-frame').contentDocument; const s = d.getElementById('sideNames'); return s && s.hidden; })()`));
  check('galgal canvas wheel inside frame', await evalJs(`!!document.getElementById('roulette-frame').contentDocument.getElementById('wheel')`));
  check('orbit rings inside frame', await evalJs(`document.getElementById('roulette-frame').contentDocument.querySelectorAll('.orbit-ring').length`) === 3);
  check('no control panel inside frame', await evalJs(`!document.getElementById('roulette-frame').contentDocument.querySelector('.panel')`));
  check('wheel footer hidden when embedded', await evalJs(`document.getElementById('roulette-frame').contentDocument.querySelector('footer').hidden`));
  // ESC closes the overlay, reopen works
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleepMs(150);
  check('ESC closes overlay', await evalJs(`document.getElementById('roulette-overlay').hidden`));
  await evalJs(`document.getElementById('b-to-roulette').click()`);
  await sleepMs(150);
  check('reopens after ESC', await evalJs(`!document.getElementById('roulette-overlay').hidden`));
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleepMs(150);
  check('ESC closes again', await evalJs(`document.getElementById('roulette-overlay').hidden`));
  // tab-4 has 9 names — reopen passes them to the already-loaded frame
  await evalJs(`document.getElementById('tab-4').click()`);
  await sleepMs(150);
  await evalJs(`document.getElementById('b-to-roulette').click()`);
  await sleepMs(700);
  check('reopen re-sends the new group to the wheel', await evalJs(`(() => { const d = document.getElementById('roulette-frame').contentDocument; return !d.getElementById('spinBtn').disabled; })()`));
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  // empty 4+ group -> inline message, no navigation (refCsv has only 1-2 card referees)
  await send('Page.navigate', { url: BASE + 'export/index.html' });
  await sleepMs(1000);
  await evalJs(`document.getElementById('f-paste').value = ${JSON.stringify(refCsv)}; document.getElementById('f-paste').dispatchEvent(new Event('input'));`);
  await sleepMs(300);
  check('tab-3 auto again with refCsv', await evalJs(`document.getElementById('tab-3').classList.contains('active') && document.getElementById('tab-3').textContent === '3 כרטיסים ומטה (2)' && document.getElementById('group-list').textContent === 'מיכל (2), מיכל (1)'`));
  await evalJs(`document.getElementById('tab-4').click()`);
  await sleepMs(200);
  check('tab-4 shows (0)', await evalJs(`document.getElementById('tab-4').textContent === '4 כרטיסים ומעלה (0)'`));
  check('empty group inline message', await evalJs(`!document.getElementById('group-head').hidden && document.getElementById('group-head').textContent.includes('אין מגישים')`));
  check('empty group hides list + disables go', await evalJs(`document.getElementById('group-list').hidden && document.getElementById('b-to-roulette').disabled`));
  check('empty group stays on export', await evalJs(`location.pathname.includes('export')`));
  // roulette (galgal wheel): fast spin picks a winner -> modal + confetti
  // entries can arrive as {name, phone} objects (the export page) — the phone
  // is shown under the winner's name in the modal
  await evalJs(`localStorage.setItem('datelink-roulette-names', JSON.stringify([{ name: 'ב', phone: '0501112222' }, { name: 'א', phone: '0523334444' }]))`);
  await send('Page.navigate', { url: `${BASE}roulette/index.html?fast=1` });
  await sleepMs(1200);
  check('ambient drift present', await evalJs(`document.querySelectorAll('.drift').length`) > 0);
  check('spin enabled with 2 names', await evalJs(`!document.getElementById('spinBtn').disabled`));
  check('side names list hidden (flag off)', await evalJs(`document.getElementById('sideNames').hidden`));
  await evalJs(`document.getElementById('spinBtn').click()`);
  await sleepMs(120);
  check('side list faded while rolling', await evalJs(`document.body.classList.contains('rolling')`));
  await sleepMs(2500);
  check('side list back after halting', await evalJs(`!document.body.classList.contains('rolling')`));
  const winner = await evalJs(`JSON.stringify({ name: document.getElementById('winnerName').textContent, phone: document.getElementById('winnerPhoneNum').textContent, phoneHidden: document.getElementById('winnerPhone').hidden })`).then(JSON.parse);
  check('winner is one of the names', ['א', 'ב'].includes(winner.name), winner.name);
  check('modal shown', await evalJs(`document.getElementById('modalOverlay').classList.contains('show')`));
  check('winner phone shown under the name', !winner.phoneHidden && winner.phone === (winner.name === 'ב' ? '0501112222' : '0523334444'), winner.phone);
  // clicking the phone copies it — plain row with a small copy icon, feedback
  // via icon->checkmark swap (not a button)
  check('copy icon next to the phone', await evalJs(`(() => { const p = document.getElementById('winnerPhone'); return !p.hidden && !!p.querySelector('.ico-copy') && p.querySelector('#winnerPhoneNum') !== null && getComputedStyle(p).cursor === 'pointer'; })()`));
  await evalJs(`(() => { try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: function (t) { window.__copiedPhone = t; return Promise.resolve(); } }, configurable: true }); } catch (e) {} document.getElementById('winnerPhone').click(); })()`);
  check('click copies the phone', await evalJs(`window.__copiedPhone`) === winner.phone, 'copied=' + await evalJs(`window.__copiedPhone`));
  check('copy feedback class added', await evalJs(`document.getElementById('winnerPhone').classList.contains('copied')`));
  check('modal stays open after copy', await evalJs(`document.getElementById('modalOverlay').classList.contains('show')`));
  await sleepMs(1400);
  check('feedback reverts after 1.2s', await evalJs(`!document.getElementById('winnerPhone').classList.contains('copied')`));
  check('confetti burst', await evalJs(`document.querySelectorAll('.confetti-piece').length`) > 0);
  check('spin button back', await evalJs(`!document.getElementById('spinBtn').classList.contains('is-hidden')`));
  // close modal, spin again (winners stay on the wheel)
  await evalJs(`document.getElementById('modalClose').click()`);
  await evalJs(`document.getElementById('spinBtn').click()`);
  await sleepMs(2600);
  check('re-spin works', ['א', 'ב'].includes(await evalJs(`document.getElementById('winnerName').textContent`)));
  check('back link to export', await evalJs(`document.querySelector('footer a').getAttribute('href') === '../export/index.html'`));
  // many names -> the list overflows the panel and scrolls
  await evalJs(`localStorage.setItem('datelink-roulette-names', JSON.stringify(Array.from({ length: 30 }, (_, i) => 'שם ' + (i + 1))));`);
  await send('Page.navigate', { url: `${BASE}roulette/index.html?fast=1` });
  await sleepMs(1000);
  check('stays hidden with 30 names', await evalJs(`document.getElementById('sideNames').hidden`));
  // no names -> empty state, spin disabled (storage cleared so no fallback can kick in)
  await send('Page.navigate', { url: BASE + 'export/index.html' });
  await sleepMs(1000);
  await evalJs(`sessionStorage.removeItem('datelink-roulette-names'); sessionStorage.removeItem('datelink-roulette-label'); localStorage.removeItem('datelink-roulette-names'); localStorage.removeItem('datelink-roulette-label');`);
  await send('Page.navigate', { url: BASE + 'roulette/index.html?fast=1' });
  await sleepMs(1000);
  check('no names -> empty state', await evalJs(`document.getElementById('spinBtn').disabled`));

  console.log('STEP: boys route');
  // /b is the same share page, feeding the boys form; its links go to /sh/b
  await send('Page.navigate', { url: BASE + 'b/index.html' });
  await sleepMs(1000);
  check('boys page same UI', await evalJs(`!!document.getElementById('f-name') && !!document.getElementById('b-copy') && document.documentElement.dir === 'rtl'`));
  check('boys page has styles', await evalJs(`getComputedStyle(document.getElementById('b-copy')).backgroundColor === 'rgb(37, 99, 168)' && getComputedStyle(document.body).fontFamily.indexOf('Rubik') !== -1`));
  await evalJs(`(() => { const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }; set('f-name', 'אבי ישראלי'); set('f-phone', '050-1234567'); })()`);
  await evalJs(`document.getElementById('b-copy').click()`);
  await sleepMs(200);
  check('boys page builds /sh/b link', await evalJs(`Tools.buildShareUrl('אבי ישראלי', '050-1234567', undefined, 'boys')`) === BASE + 'sh/b/index.html?n=~abj+jutalj&n=~AFABCDEFGH');
  // the boys redirect lands on the boys form with the referee entries
  await send('Page.navigate', { url: BASE + 'sh/b/index.html?n=' + encodeURIComponent('אבי ישראלי') + '&n=' + encodeURIComponent('050-1234567') });
  await sleepMs(1500);
  const boysTarget = await evalJs(`location.href`);
  check('sh/b redirects to the boys form', boysTarget.indexOf('1FAIpQLSdYrIxaJ9skefLmWb9z04qVt2K-UP4XiO1DdumDMbJ3PsguHQ/viewform') !== -1 && boysTarget.indexOf('entry.885956976') !== -1 && boysTarget.indexOf('entry.488453562') !== -1, boysTarget.slice(0, 120));
  await send('Page.navigate', { url: BASE + 'sh/b/index.html' });
  await sleepMs(1000);
  check('sh/b without details goes back to the generator', await evalJs(`location.href.includes('index.html') && !location.href.includes('docs.google.com')`));

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
