/* מיזם שידוכים — כלים (shared logic: form link builder, CSV parser, card builder)
   Browser: window.Tools. Node: module.exports. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Tools = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ===== configuration ===== */
  var CONFIG = {
    FORM_URL: 'https://docs.google.com/forms/d/e/1FAIpQLScFmbqLvxsIgdu0fqneZyuifsGFQ-wY00LB15CY4B4NRIHSbA/viewform',
    ENTRY_NAME: 'entry.1659420434', // שם מלא
    ENTRY_PHONE: 'entry.632618070'  // מספר פלאפון
  };

  /* ===== helpers ===== */
  function clean(v) { return String(v == null ? '' : v).replace(/\r/g, '').trim(); }

  /* ===== photos: Google Drive links inside the CSV photo column ===== */
  /* extract Drive file IDs from a cell (any number of links, any separators) */
  function extractFileIds(v) {
    var out = [];
    var m;
    var re = /(?:drive\.google\.com|docs\.google\.com|(?:[\w-]+\.)*googleusercontent\.com)\/[^\s"',;)]+/g;
    while ((m = re.exec(String(v || '')))) {
      var u = m[0];
      var id = null;
      var a = u.match(/[?&]id=([-\w]{20,})/);
      if (a) id = a[1];
      if (!id) { var b = u.match(/\/d\/([-\w]{20,})/); if (b) id = b[1]; }
      if (id && out.indexOf(id) === -1) out.push(id);
    }
    return out;
  }

  /* thumbnail image URL — loads only for Google accounts with access to the file */
  function thumbUrl(id) { return 'https://drive.google.com/thumbnail?id=' + id + '&sz=w800'; }
  /* link to open the original file */
  function openUrl(id) { return 'https://drive.google.com/open?id=' + id; }
  /* link that downloads the original file (requires the viewer's Drive access) */
  function downloadUrl(id) { return 'https://drive.google.com/uc?export=download&id=' + id; }

  /* ===== CSV parsing (RFC-4180-ish: quotes, commas & newlines inside quotes) ===== */
  function parseCSV(text) {
    text = String(text || '').replace(/^\uFEFF/, '');
    var rows = [], field = '', row = [], inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else if (c === '"') {
        inQ = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
      } else if (c !== '\r') {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); });
  }

  /* header matching — normalize a question title for comparison */
  function normHeader(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\s+([,:+])/g, '$1')
      .replace(/[\u201c\u201d"״]/g, '')
      .replace(/\s*[:*]\s*$/, '')
      .trim();
  }

  /* form question title -> card field key (aliases in order of preference) */
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
    phone: ['מספר פלאפון לברורים ויצירת קשר', 'מספר טלפון לברורים ויצירת קשר', 'מספר פלאפון', 'טלפון'],
    personal: ['מספר טלפון אישי', 'מספר פלאפון אישי']
  };

  /* columns that exist in the responses sheet but must NOT appear in cards */
  var IGNORED_HEADERS = ['חותמת זמן', 'timestamp', 'שם מלא', 'מספר פלאפון', 'הגעתי דרך', 'צירוף תמונה', 'מספר פלאפון אישי'];

  /* map CSV header row -> { colByField, combinedLooking, unknown }
     Handles question titles that contain commas (Sheets does not quote headers,
     so such a title arrives split across adjacent cells — we merge and re-match). */
  function mapHeaders(headers) {
    var colByField = {};
    var combinedLooking = -1;
    var unknown = [];

    var keys = Object.keys(HEADER_ALIASES);
    var normAliases = {};
    keys.forEach(function (k) {
      normAliases[k] = HEADER_ALIASES[k].map(normHeader).sort(function (a, b) { return b.length - a.length; });
    });
    // flat (field, alias) list, longest alias first — so the most specific
    // field wins when a header contains several aliases (e.g. the personal-phone
    // header contains both "מספר טלפון אישי" and the generic "טלפון")
    var flatAliases = [];
    keys.forEach(function (k) {
      normAliases[k].forEach(function (a) { flatAliases.push([k, a]); });
    });
    flatAliases.sort(function (x, y) { return y[1].length - x[1].length; });

    function exactMatch(nh) {
      var matched = null;
      keys.forEach(function (k) {
        if (matched) return;
        normAliases[k].forEach(function (a) {
          if (!matched && a === nh) matched = k;
        });
      });
      return matched;
    }

    function matchAliases(nh) {
      var matched = exactMatch(nh);
      if (!matched) { // fallback: long alias contained in the header (longest first)
        for (var f = 0; f < flatAliases.length && !matched; f++) {
          var a = flatAliases[f][1];
          if (a.length >= 4 && nh.indexOf(a) !== -1) matched = flatAliases[f][0];
        }
      }
      return matched;
    }

    var i = 0;
    var shift = 0; // merged titles span extra header cells but only one data column
    var imageCols = []; // photo columns (question titles containing "צירוף/העלאה תמונה")
    var refNameCol = -1, refPhoneCol = -1; // referee identity = last two fields (שם מלא + phone)
    while (i < headers.length) {
      var h = headers[i];
      var nh = normHeader(h);
      if (!nh) { i++; continue; }

      if (nh === 'שם מלא') refNameCol = i - shift;
      if (nh === 'מספר טלפון' || nh === 'מספר פלאפון') refPhoneCol = i - shift; // last one wins

      var matched = null;
      var end = i; // last consumed header index
      // try merging with the next 1-2 cells (title with an embedded comma) —
      // exact alias match ONLY (a contains-match here would swallow the next column)
      for (var span = 1; span <= 2 && !matched && i + span < headers.length; span++) {
        var merged = normHeader(headers.slice(i, i + span + 1).join(' '));
        if (merged) matched = exactMatch(merged);
        if (matched) end = i + span;
      }
      if (!matched) {
        matched = matchAliases(nh);
        end = i;
      }

      if (matched) {
        if (matched === 'looking' && normHeader(headers.slice(i, end + 1).join(' ')).indexOf('טווח גיל') !== -1) {
          combinedLooking = i - shift;
        }
        if (!(matched in colByField)) colByField[matched] = i - shift;
        shift += end - i;
        i = end + 1;
      } else if (/^(צירוף|העלאה|הוספת)[^]*תמונה/.test(nh)) {
        imageCols.push(i - shift);
        i++;
      } else {
        var ignored = IGNORED_HEADERS.some(function (ig) { return nh.indexOf(normHeader(ig)) !== -1; });
        if (!ignored) unknown.push(h);
        i++;
      }
    }
    return { colByField: colByField, combinedLooking: combinedLooking, unknown: unknown, imageCols: imageCols, refNameCol: refNameCol, refPhoneCol: refPhoneCol };
  }

  /* split a combined "מה אני מחפש+ טווח גילאים" answer into looking + age range */
  function splitLooking(v) {
    v = String(v == null ? '' : v).replace(/\r/g, '').trim();
    if (!v) return { looking: '', agerange: '' };

    // explicit "טווח גילאים:" (or similar) line inside the answer
    if (v.indexOf('טווח גיל') !== -1) {
      var at = v.indexOf('טווח גיל');
      var head = v.slice(0, at).trim();
      var tail = v.slice(at).replace(/^טווח\s*גיל[^:\n]*[:–—-]?\s*/, '').trim();
      return { looking: head, agerange: tail };
    }

    // inline range at the end, e.g. "בחורה רצינית בת 22-27" / "בת 22 עד 27" / "בחורה חמה 25-30"
    var r = v.match(/(?:בת|בן|גיל)\s*\d{1,2}\s*(?:[-–—]|עד)\s*\d{1,3}/) ||
      v.match(/\d{1,2}\s*[-–—]\s*\d{1,3}/);
    if (r) {
      var rest = v.slice(r.index + r[0].length).trim();
      if (!rest) return { looking: v.slice(0, r.index).trim(), agerange: v.slice(r.index).trim() };
    }
    return { looking: v, agerange: '' };
  }

  /* ===== card building ===== */
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

  /* build one card's txt from a record {name, age, ...}; null when no name */
  function buildCard(rec) {
    var name = clean(rec.name);
    if (!name) return null;
    var sections = [];
    var inline = INLINE_FIELDS
      .map(function (f) { var v = clean(rec[f[0]]); return v ? f[1] + ': ' + v : ''; })
      .filter(Boolean);
    if (inline.length) sections.push(inline.join('\n'));
    BLOCK_FIELDS.forEach(function (f) {
      var v = clean(rec[f[0]]);
      if (v) sections.push(f[1] + '\n' + v);
    });
    return '✨ ' + name + ' ✨\n\n' + sections.join('\n\n');
  }

  /* join cards with exactly 3 blank lines between them */
  function joinCards(cards) { return cards.map(cardText).join('\n\n\n'); }

  /* plain card text (what gets copied) */
  function cardText(c) { return typeof c === 'string' ? c : c.text; }

  /* card text + its photo links (for the txt download) */
  function cardWithImages(c) {
    var t = cardText(c);
    var imgs = (c.images || []).map(function (id) { return '🖼️ תמונה: ' + openUrl(id); });
    return imgs.length ? t + '\n\n' + imgs.join('\n') : t;
  }

  /* full export text (cards + photo links), same blank-line spacing */
  function exportAllText(cards) { return cards.map(cardWithImages).join('\n\n\n'); }

  /* ===== referee stats ===== */
  /* normalize a phone for KEYING only (display stays as typed): strip all
     formatting, convert a leading 972/+972/00 to 0 */
  function normPhone(v) {
    var d = String(v == null ? '' : v).replace(/\D+/g, '');
    if (d.indexOf('00') === 0) d = d.slice(2);
    if (d.indexOf('972') === 0 && d.length > 3) d = '0' + d.slice(3);
    return d;
  }

  /* referees are keyed by the REF phone (last field); a referee's card count is
     the number of DISTINCT card identities — keyed by the card's PERSONAL phone
     (מספר טלפון אישי, unique per candidate), falling back to the contact phone,
     then to the row itself. The same candidate submitted twice counts once.
     Names are display-only. */
  function refereeStats(cards) {
    var byPhone = {};
    var order = [];
    cards.forEach(function (c, i) {
      if (!c.ref || !c.ref.phone) return;
      var p = normPhone(c.ref.phone);
      if (!byPhone[p]) { byPhone[p] = { name: c.ref.name || '', phones: {}, count: 0, display: c.ref.phone }; order.push(p); }
      var r = byPhone[p];
      if (!r.name && c.ref.name) r.name = c.ref.name;
      var key = normPhone(c.personal) || normPhone(c.phone) || '__row' + i; // cards without any phone count individually
      if (!(key in r.phones)) { r.phones[key] = true; r.count++; }
    });
    return order.map(function (p) { var r = byPhone[p]; return { phone: r.display, name: r.name, count: r.count }; });
  }

  /* referees with at least minCards and at most maxCards cards, sorted
     (maxCards empty = no upper limit; most cards first, then Hebrew name) */
  function filterRefereeGroups(cards, minCards, maxCards) {
    minCards = Math.max(1, parseInt(minCards, 10) || 1);
    var max = maxCards === '' || maxCards == null ? Infinity : Math.max(0, parseInt(maxCards, 10) || 0);
    return refereeStats(cards)
      .filter(function (r) { return r.count >= minCards && r.count <= max && r.name; })
      .sort(function (a, b) {
        return b.count - a.count || String(a.name).localeCompare(String(b.name), 'he');
      })
      .map(function (r) { return { name: r.name, phone: r.phone, count: r.count }; });
  }

  /* the message copied/shared from the landing page (kept in one place so the
     copy, system-share and WhatsApp paths stay identical) */
  function buildShareText(url) {
    return 'מיזם שידוכים וארשתיך המיועד לבחורים במגזר הדתי לאומי תורני.\n\nכל הפרטים בקישור:\n' + url;
  }

  /* names only (the roulette needs just the names) */
  function filterReferees(cards, minCards, maxCards) {
    return filterRefereeGroups(cards, minCards, maxCards).map(function (r) { return r.name; });
  }

  /* ===== full pipeline: CSV text -> { cards, skipped, unknown } ===== */
  function parseAll(csvText) {
    var rows = parseCSV(csvText);
    if (!rows.length) return { cards: [], skipped: 0, unknown: [], combined: false };
    // lenient repair: an unquoted newline inside a field splits one row into two —
    // merge short rows into their predecessor until it matches the data width
    // (the header row may be wider when a title contains a comma)
    var dataWidth = 0;
    for (var rr = 1; rr < rows.length; rr++) {
      if (rows[rr].length) { dataWidth = rows[rr].length; break; }
    }
    if (dataWidth) {
      for (var r2 = 1; r2 < rows.length - 1; r2++) {
        while (rows[r2].length < dataWidth && r2 + 1 < rows.length) {
          rows[r2] = rows[r2].concat(rows[r2 + 1]);
          rows.splice(r2 + 1, 1);
        }
      }
    }
    var map = mapHeaders(rows[0]);
    var cards = [];
    var skipped = 0;
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      var rec = {};
      Object.keys(map.colByField).forEach(function (k) {
        var idx = map.colByField[k];
        if (idx < row.length) rec[k] = clean(row[idx]);
      });
      if (map.combinedLooking !== -1 && !rec.agerange && !(map.colByField.agerange >= 0)) {
        var split = splitLooking(rec.looking);
        rec.looking = split.looking;
        rec.agerange = split.agerange;
      }
      var card = buildCard(rec);
      if (card) {
        var images = [];
        map.imageCols.forEach(function (ic) {
          if (ic < row.length) images = images.concat(extractFileIds(row[ic]));
        });
        var ref = null;
        if (map.refNameCol >= 0 && map.refPhoneCol >= 0 &&
            map.refNameCol < row.length && map.refPhoneCol < row.length) {
          var rn = clean(row[map.refNameCol]);
          var rp = clean(row[map.refPhoneCol]);
          if (rn || rp) ref = { name: rn, phone: rp };
        }
        cards.push({ text: card, images: images, ref: ref, phone: rec.phone || '', personal: rec.personal || '' });
      } else {
        skipped++;
      }
    }
    return { cards: cards, skipped: skipped, unknown: map.unknown, combined: map.combinedLooking !== -1 };
  }

  /* ===== page 1: build the prefilled form link ===== */
  function buildFormLink(name, phone) {
    return CONFIG.FORM_URL + '?usp=pp_url&' +
      CONFIG.ENTRY_NAME + '=' + encodeURIComponent(clean(name)) + '&' +
      CONFIG.ENTRY_PHONE + '=' + encodeURIComponent(clean(phone));
  }

  /* ===== clipboard (browser only; node returns false) ===== */
  function copyText(text) {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return Promise.resolve(false);
    return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () {
      // fallback for file:// contexts
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return Promise.resolve(ok);
      } catch (e) { return Promise.resolve(false); }
    });
  }

  function showToast(msg, isErr) {
    if (typeof document === 'undefined') return;
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ===== demo data (mirrors the real form's columns) ===== */
  var SAMPLE_CSV = [
    'שם + שם משפחה:,גיל:,סטטוס:,רמה דתית:,עדה , רקע משפחתי:,מגורים:,עיסוק,קצת עלי:,מה אני מחפש+ טווח גילאים:,מספר פלאפון לברורים ויצירת קשר:,מספר פלאפון אישי שלך: (לא יפורסם ),צירוף תמונה עדכנית: (עד שתי תמונות),הגעתי דרך:,שם מלא:,מספר פלאפון:,חותמת זמן',
    'ישראל ישראלי,25,רווק,דתי לאומי,"אשכנזי, משפחה חמה",ירושלים,סטודנט להנדסה,"אני בן אדם חביב ונחמד, כליל המעלות והשלמות",בחורה רצינית בת 22-27,050-1111111,050-2222222,,ווצאפ,אבי ישראלי,050-3333333,2026-01-01 10:00:00',
    'משה כהן,27,רווק,דתי,"ספרדי, עדה ירושלמית",חיפה,איש הייטק,"מחפש בחורה טובה\nעם מידות טובות","מחפש בחורה רצינית\nטווח גילאים: 24-28",050-4444444,050-5555555,"https://drive.google.com/open?id=Abc1234567890XyZ-_Qwerty, https://drive.google.com/file/d/Def9876543210Uiop-_-Lkjhg/view",קבוצה,יצחק כהן,050-6666666,2026-01-02 12:30:00',
    'דוד לוי,,רווק,דתי לאומי,"אשכנזי",בני ברק,אברך,,מחפש שידוך הולם,050-7777777,050-8888888,,אתר,שמעון לוי,050-9999999,2026-01-03 09:15:00'
  ].join('\n');

  return {
    CONFIG: CONFIG,
    parseCSV: parseCSV,
    mapHeaders: mapHeaders,
    splitLooking: splitLooking,
    buildCard: buildCard,
    joinCards: joinCards,
    parseAll: parseAll,
    buildFormLink: buildFormLink,
    extractFileIds: extractFileIds,
    thumbUrl: thumbUrl,
    openUrl: openUrl,
    downloadUrl: downloadUrl,
    cardText: cardText,
    cardWithImages: cardWithImages,
    exportAllText: exportAllText,
    refereeStats: refereeStats,
    filterReferees: filterReferees,
    filterRefereeGroups: filterRefereeGroups,
    buildShareText: buildShareText,
    normPhone: normPhone,
    copyText: copyText,
    showToast: showToast,
    SAMPLE_CSV: SAMPLE_CSV
  };
});
