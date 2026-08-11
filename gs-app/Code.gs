/**
 * datelink export web-app — reads the Google Form responses sheet, matches the
 * uploaded images from the form's Drive folder (name + submission timestamp),
 * and renders the cards with their photos.
 *
 * SETUP (one time, ~3 minutes):
 *   1. Open the responses spreadsheet (the one the form writes to) in Google Sheets.
 *   2. Extensions → Apps Script. Delete the default code, paste this file, save.
 *   3. Run `setup()` once (authorizes; sets the upload folder to "anyone with the link").
 *   4. Deploy → New deployment → Web app → Execute as: Me → Access: Anyone → Deploy.
 *   5. The /exec URL is the new export page.
 */

var CONFIG = {
  // Optional overrides. Leave '' for auto-detection:
  SPREADSHEET_ID: '',     // e.g. '1AbC...'; when '' the bound/active spreadsheet is used
  FORM_TITLE: 'וְאֵרַשְׂתִּיךְ – מיזם שידוכים',  // used to find the upload folder by name
  UPLOAD_FOLDER_ID: '',   // e.g. '0Bx...'; when '' the folder is searched by name
  // Which header holds the uploaded-file names:
  IMAGE_HEADER_HINTS: ['צירוף תמונה', 'תמונה', 'העלאת תמונות', 'קובץ מצורף'],
  // Uploads happen within seconds of the row timestamp; window guards against
  // equal filenames from different submissions:
  MATCH_WINDOW_MS: 5 * 60 * 1000,
  IMAGE_MAX: 2, // how many photos to show per card
  // The ONLY accounts that may open the app. Fill with your email + your partner's.
  ALLOWED_EMAILS: ['PUT-YOUR-EMAIL@gmail.com', 'PUT-PARTNER-EMAIL@gmail.com']
};

function setup() {
  checkEmails_();
  var ss = getSpreadsheet_();
  var folder = getUploadFolder_();
  if (!folder) throw new Error('Upload folder not found. Open CONFIG and set UPLOAD_FOLDER_ID (from the folder URL in Drive).');
  var out = '✓ Responses sheet: ' + ss.getName() + '\n' +
    '✓ Upload folder: ' + folder.getName() + ' (' + countFiles_(folder) + ' files)\n';
  // Sharing changes work only for the folder OWNER — try it, and if we cannot,
  // do the same thing manually in the Drive web UI (see README).
  try {
    folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    CONFIG.ALLOWED_EMAILS.forEach(function (em) { folder.addViewer(em); });
    out += '✓ Folder shared ONLY with: ' + CONFIG.ALLOWED_EMAILS.join(', ') + '\n';
  } catch (e) {
    out += '⚠ Could not change folder sharing from this account (you are not the owner).\n' +
      '  Do it manually in Drive: right-click the folder → Share → add the second email as Viewer,\n' +
      '  and make sure "Anyone with the link" is OFF.\n';
  }
  out += 'Now: Deploy → New deployment → Web app → Execute as: Me → Access: Anyone with Google account.';
  Logger.log(out);
  return out;
}

/* the app answers only to the two accounts in ALLOWED_EMAILS */
function checkEmails_() {
  CONFIG.ALLOWED_EMAILS.forEach(function (em) {
    if (!em || em.indexOf('PUT-') === 0) throw new Error('Fill CONFIG.ALLOWED_EMAILS with your two emails first.');
  });
}

function allowed_() {
  checkEmails_();
  var user = Session.getActiveUser().getEmail();
  return user && CONFIG.ALLOWED_EMAILS.indexOf(user) !== -1;
}

function denyPage_() {
  return HtmlService.createHtmlOutput(
    '<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"></head><body style="font-family:Arial;text-align:center;padding-top:60px;color:#14324f">' +
    '<h2>אין גישה</h2><p>העמוד פתוח רק לחשבונות מורשים.</p></body></html>')
    .setTitle('אין גישה');
}

function countFiles_(folder) {
  var f = folder.getFiles(), n = 0;
  while (f.hasNext()) { f.next(); n++; }
  return n;
}

function getSpreadsheet_() {
  if (CONFIG.SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var active = SpreadsheetApp.getActive();
  if (active) return active;
  // last resort: first spreadsheet whose title contains the form title.
  // NOTE: set SPREADSHEET_ID in CONFIG to skip this search entirely.
  var it = DriveApp.searchFiles('mimeType="application/vnd.google-apps.spreadsheet" and title contains "' + CONFIG.FORM_TITLE.split(' ')[0] + '"');
  if (it.hasNext()) return SpreadsheetApp.open(it.next());
  throw new Error('Spreadsheet not found — set CONFIG.SPREADSHEET_ID (copy from the sheet URL).');
}

function getUploadFolder_() {
  if (CONFIG.UPLOAD_FOLDER_ID) return DriveApp.getFolderById(CONFIG.UPLOAD_FOLDER_ID);
  var patterns = ['(File responses)', CONFIG.FORM_TITLE.split(' ')[0]];
  var best = null, bestDate = null;
  for (var p = 0; p < patterns.length; p++) {
    var it = DriveApp.searchFiles(
      'mimeType="application/vnd.google-apps.folder" and title contains "' + patterns[p] + '" and trashed = false');
    while (it.hasNext()) {
      var f = it.next();
      var d = f.getLastUpdated();
      if (!bestDate || d > bestDate) { best = f; bestDate = d; }
    }
    if (best) return best;
  }
  return null;
}

/* ===== text utils (ported from datelink app.js so cards are identical) ===== */

function clean(v) {
  return String(v == null ? '' : v)
    .replace(/[\u201c\u201d"״]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,:+])/g, '$1')
    .replace(/\s*[:*]\s*$/, '')
    .trim();
}

function normHeader(h) {
  return String(h == null ? '' : h)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,:+])/g, '$1')
    .replace(/[\u201c\u201d"״]/g, '')
    .replace(/\s*[:*]\s*$/, '')
    .trim();
}

var HEADER_ALIASES = {
  name: ['שם + שם משפחה', 'שם ושם משפחה', 'שם מלא', 'שם'],
  age: ['גיל'],
  status: ['סטטוס'],
  height: ['גובה'],
  relig: ['רמה דתית'],
  origin: ['עדה, רקע משפחתי', 'עדה רקע משפחתי', 'עדה ורקע משפחתי', 'עדה', 'רקע משפחתי'],
  location: ['מגורים', 'עיר מגורים', 'מקום מגורים'],
  occupation: ['עיסוק', 'תחום עיסוק'],
  about: ['קצת עלי', 'קצת עליי', 'על עצמי', 'קצת על עצמי'],
  looking: ['מה אני מחפש+ טווח גילאים', 'מה אני מחפש + טווח גילאים', 'מה אני מחפש וטווח גילאים', 'מה אני מחפש'],
  agerange: ['טווח גילאים', 'טווח הגילאים'],
  phone: ['מספר פלאפון לברורים ויצירת קשר', 'מספר טלפון לברורים ויצירת קשר', 'מספר פלאפון', 'טלפון']
};

var IGNORED_HEADERS = ['חותמת זמן', 'timestamp', 'שם מלא', 'מספר פלאפון', 'הגעתי דרך', 'מספר פלאפון אישי'];

function mapColumn_(headers) {
  var colByField = {};
  var normAliases = {};
  Object.keys(HEADER_ALIASES).forEach(function (k) {
    normAliases[k] = HEADER_ALIASES[k].map(normHeader).sort(function (a, b) { return b.length - a.length; });
  });
  headers.forEach(function (h, i) {
    var nh = normHeader(h);
    if (!nh) return;
    var matched = null;
    Object.keys(normAliases).forEach(function (k) {
      if (matched) return;
      normAliases[k].forEach(function (a) {
        if (!matched && a === nh) matched = k;
      });
    });
    if (!matched) {
      Object.keys(normAliases).forEach(function (k) {
        if (matched) return;
        normAliases[k].forEach(function (a) {
          if (!matched && a.length >= 4 && nh.indexOf(a) !== -1) matched = k;
        });
      });
    }
    if (matched && !(matched in colByField)) colByField[matched] = i;
  });
  return colByField;
}

function splitLooking(v) {
  v = String(v == null ? '' : v).replace(/\r/g, '').trim();
  if (!v) return { looking: '', agerange: '' };
  if (v.indexOf('טווח גיל') !== -1) {
    var at = v.indexOf('טווח גיל');
    return { looking: v.slice(0, at).trim(), agerange: v.slice(at).replace(/^טווח\s*גיל[^:\n]*[:–—-]?\s*/, '').trim() };
  }
  var r = v.match(/(?:בת|בן|גיל)\s*\d{1,2}\s*(?:[-–—]|עד)\s*\d{1,3}/) ||
    v.match(/\d{1,2}\s*[-–—]\s*\d{1,3}/);
  if (r) {
    var rest = v.slice(r.index + r[0].length).trim();
    if (!rest) return { looking: v.slice(0, r.index).trim(), agerange: v.slice(r.index).trim() };
  }
  return { looking: v, agerange: '' };
}

var INLINE_FIELDS = [['age', 'גיל'], ['status', 'סטטוס'], ['height', 'גובה'], ['relig', 'רמה דתית']];
var BLOCK_FIELDS = [
  ['origin', '👳🏻 עדה, רקע משפחתי:'],
  ['location', '🏡 מגורים:'],
  ['occupation', '🎓 עיסוק:'],
  ['about', '🧍‍♂️ קצת עלי:'],
  ['looking', '🎯 מה אני מחפש:'],
  ['agerange', 'טווח גילאים:'],
  ['phone', '☎️ מספר טלפון לברורים ויצירת קשר:']
];

function buildCard(rec) {
  var name = clean(rec.name);
  if (!name) return null;
  var sections = [];
  var inline = INLINE_FIELDS
    .map(function (f) { var v = clean(rec[f[0]]); return v ? f[1] + ': ' + v : ''; })
    .filter(function (x) { return x; });
  if (inline.length) sections.push(inline.join('\n'));
  BLOCK_FIELDS.forEach(function (f) {
    var v = clean(rec[f[0]]);
    if (v) sections.push(f[1] + '\n' + v);
  });
  var card = '✨ ' + name + ' ✨\n\n' + sections.join('\n\n');
  if (rec.images && rec.images.length) {
    card += '\n\n📷 תמונות:\n' + rec.images.map(function (im) { return im.viewUrl; }).join('\n');
  }
  return card;
}

/* ===== data: sheet rows + drive files ===== */

function loadData_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheets()[0];
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) throw new Error('הגיליון ריק — עדיין אין תשובות.');

  var headers = values[0].map(normHeader);
  var colByField = mapColumn_(headers);
  var imageCol = -1;
  for (var i = 0; i < headers.length; i++) {
    for (var h = 0; h < CONFIG.IMAGE_HEADER_HINTS.length; h++) {
      if (headers[i].indexOf(CONFIG.IMAGE_HEADER_HINTS[h]) !== -1) { imageCol = i; break; }
    }
    if (imageCol !== -1) break;
  }
  var tsCol = 0;
  for (var t = 0; t < headers.length; t++) {
    if (headers[t].indexOf('חותמת') !== -1 || headers[t].indexOf('timestamp') !== -1) { tsCol = t; break; }
  }

  var folder = getUploadFolder_();
  var byName = {};
  var nFiles = 0;
  if (folder) {
    var files = folder.getFiles();
    while (files.hasNext()) {
      var f = files.next();
      nFiles++;
      var created = f.getDateCreated();
      if (!byName[f.getName()]) byName[f.getName()] = [];
      byName[f.getName()].push({ id: f.getId(), created: created.getTime() });
    }
  }

  var cards = [];
  var unmatched = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var rec = {};
    Object.keys(colByField).forEach(function (k) {
      var idx = colByField[k];
      if (idx < row.length) rec[k] = clean(row[idx]);
    });
    var ts = row[tsCol] instanceof Date ? row[tsCol].getTime() : null;

    if (imageCol !== -1 && imageCol < row.length && String(row[imageCol] || '').trim()) {
      var names = String(row[imageCol]).split(/\s*,\s*|\n+/).filter(function (n) { return n.trim(); });
      var images = [];
      for (var nI = 0; nI < names.length && images.length < CONFIG.IMAGE_MAX; nI++) {
        var name = names[nI].trim();
        var cands = byName[name] || [];
        var pick = null;
        for (var c = 0; c < cands.length; c++) {
          if (!pick) { pick = cands[c]; continue; }
          var dPick = ts === null ? 0 : Math.abs(cands[c].created - ts);
          var dCur = ts === null ? 0 : Math.abs(pick.created - ts);
          if (dPick < dCur) pick = cands[c];
        }
        if (pick && (ts === null || Math.abs(pick.created - ts) <= CONFIG.MATCH_WINDOW_MS)) {
          images.push({
            name: name,
            id: pick.id,
            thumbUrl: 'https://drive.google.com/thumbnail?id=' + pick.id + '&sz=w1000',
            viewUrl: 'https://drive.google.com/file/d/' + pick.id + '/view'
          });
        } else {
          unmatched.push(name);
        }
      }
      if (images.length) rec.images = images;
    }

    var card = buildCard(rec);
    if (card) cards.push({ text: card, images: rec.images || [] });
  }

  return {
    cards: cards,
    unmatched: unmatched,
    nFiles: nFiles,
    folderName: folder ? folder.getName() : null,
    imageCol: imageCol
  };
}

/* ===== endpoints ===== */

function doGet(e) {
  var p = e && e.parameter || {};
  if (!allowed_()) return denyPage_();
  if (p.json === '1') {
    var data = loadData_();
    return ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var data = loadData_();
  var html = renderHtml_(data);
  return HtmlService.createHtmlOutput(html)
    .setTitle('מיזם שידוכים — כרטיסים')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function renderHtml_(data) {
  var cardsHtml = data.cards.map(function (c, i) {
    var imgs = '';
    (c.images || []).forEach(function (im) {
      imgs += '<a class="ph" href="' + im.viewUrl + '" target="_blank" rel="noopener"><img loading="lazy" src="' + im.thumbUrl + '" alt="תמונה"></a>';
    });
    var esc = c.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<article class="card" data-i="' + i + '">' + imgs +
      '<pre>' + esc + '</pre>' +
      '<div class="row"><button class="copy" data-i="' + i + '">📋 העתק כרטיס</button></div>' +
      '</article>';
  }).join('');

  var notice = '';
  if (data.unmatched.length) {
    notice = '<div class="notice">⚠️ לא נמצאו ' + data.unmatched.length + ' תמונות בגיליון התשובות (שמות שלא נמצאו בתיקיית ההעלאות).</div>';
  }

  return '<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700&display=swap" rel="stylesheet">' +
    '<style>' +
    'body{margin:0;font-family:Rubik,Segoe UI,Arial,sans-serif;background:#eef4fb;color:#14324f;direction:rtl}' +
    'header{background:#14324f;color:#fff;padding:20px 18px;text-align:center}' +
    'header h1{margin:0 0 10px;font-size:22px}' +
    'input{width:min(560px,92%);padding:12px 16px;border:1px solid #c9d9e8;border-radius:10px;font:inherit;font-size:15px}' +
    'main{max-width:820px;margin:22px auto;padding:0 14px 60px}' +
    '.meta{color:#5b7a99;text-align:center;margin:10px 0 18px;font-size:13px}' +
    '.card{background:#f5f9fd;border-radius:14px;padding:18px 20px;margin:0 0 22px;box-shadow:0 4px 22px rgba(26,58,96,.1)}' +
    '.card pre{white-space:pre-wrap;word-break:break-word;font:inherit;font-size:15px;line-height:1.75;margin:10px 0;color:#14324f}' +
    '.ph{display:inline-block;margin:0 6px 8px 0}' +
    '.ph img{height:170px;max-width:100%;border-radius:10px;box-shadow:0 2px 8px rgba(26,58,96,.18);background:#fff}' +
    '.row{text-align:left}' +
    'button{background:#1f5e9e;color:#fff;border:none;border-radius:10px;padding:10px 18px;font:inherit;font-size:14px;cursor:pointer}' +
    'button:hover{background:#173f6e}' +
    '.notice{background:#fff3e0;border:1px solid #ffcc80;color:#7a4f01;border-radius:10px;padding:10px 14px;margin:0 0 18px;font-size:14px}' +
    '.empty{text-align:center;color:#5b7a99;padding:40px 0}' +
    '#toast{position:fixed;bottom:24px;right:50%;transform:translateX(50%);background:#14324f;color:#fff;padding:12px 22px;border-radius:30px;font-size:14px;box-shadow:0 6px 24px rgba(0,0,0,.25);z-index:9}' +
    '</style></head><body>' +
    '<header><h1>מיזם שידוכים — כרטיסים</h1><input id="q" placeholder="חיפוש לפי שם, טלפון, עיר…" oninput="filterCards()"></header>' +
    '<main>' +
    '<div class="meta">' + data.cards.length + ' כרטיסים · ' + (data.nFiles || 0) + ' קבצים בתיקיית התמונות' + notice + '</div>' +
    '<div id="list">' + cardsHtml + '</div>' +
    '</main>' +
    '<div id="toast" hidden></div>' +
    '<script>' +
    'var cards=' + JSON.stringify(data.cards.map(function (c) { return c.text; })) + ';' +
    'function filterCards(){var q=document.getElementById("q").value.trim();' +
    'document.querySelectorAll(".card").forEach(function(c){c.hidden=q&&c.textContent.indexOf(q)===-1;});}' +
    'function toast(m){var t=document.getElementById("toast");t.textContent=m;t.hidden=false;clearTimeout(t._x);t._x=setTimeout(function(){t.hidden=true;},2200);}' +
    'document.addEventListener("click",function(e){var b=e.target.closest("button.copy");if(!b)return;' +
    'navigator.clipboard.writeText(cards[Number(b.dataset.i)]).then(function(){toast("✓ הכרטיס הועתק!");},function(){toast("לא ניתן היה להעתיק",true);});});' +
    '</script></body></html>';
}
