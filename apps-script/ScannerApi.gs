/**
 * Annual Day 2026 - JSON API for the GitHub Pages volunteer scanner.
 *
 * ADD THIS AS A NEW FILE in the existing "Annual Day 2026 Gate Pass" project.
 * It is additive: it changes no existing function and adds no new write path.
 * Every operation delegates to code that is already in the project:
 *
 *   login  -> volunteerLogin(id, pin)                     VolunteerAuth.gs
 *   scan   -> recordBadgeAction(token, action, session)   WebApp.gs  (the only write)
 *   logout -> volunteerLogout(session)                    VolunteerAuth.gs
 *
 * Extra reads (no writes):
 *   - Manual entry of a printed Badge ID is resolved to its QR Token.
 *   - After a scan, the attendee's name/relationship/department are returned
 *     so the volunteer sees who was scanned.
 *
 * Why a doPost is needed: google.script.run only works inside pages served by
 * this script. A static page on GitHub Pages can only reach the script over
 * HTTP, and the project has no doPost today. doGet is untouched.
 *
 * The scanner POSTs JSON as text/plain (no custom headers), which avoids the
 * CORS preflight that Apps Script cannot answer.
 */
function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (req.op === 'login') {
      out = volunteerLogin(req.volunteerId, req.pin);
    } else if (req.op === 'scan') {
      out = scannerApiScan_(req);
    } else if (req.op === 'logout') {
      out = volunteerLogout(req.session);
    } else {
      out = { ok: false, result: 'ERROR', message: 'Unknown operation' };
    }
  } catch (err) {
    // e.g. LockService timeout in recordBadgeAction. The phone keeps the scan and retries.
    out = { ok: false, result: 'SERVER_ERROR', message: String((err && err.message) || err) };
  }

  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function scannerApiScan_(req) {
  var action = req.action === 'gate' || req.action === 'food' ? req.action : '';
  if (!action) {
    return { ok: false, result: 'ERROR', message: 'Invalid scanning action' };
  }

  var token = scannerApiToken_(req.code);
  var res = recordBadgeAction(token, action, req.session);

  // Classify recordBadgeAction's messages so the page doesn't parse text.
  var m = String((res && res.message) || '');
  if (res && res.ok) {
    res.result = /ALREADY/.test(m) ? 'DUPLICATE' : 'OK';
  } else if (m === 'Invalid badge') {
    res.result = 'NOT_FOUND';
  } else if (m === 'Badge is not active') {
    res.result = 'BLOCKED';
  } else if (/session|log in|inactive or changed/i.test(m)) {
    res.result = 'SESSION';
  } else {
    res.result = 'ERROR';
  }

  if (res.result !== 'SESSION' && res.result !== 'NOT_FOUND') {
    var hit = attendeeByToken_(token);
    if (hit) {
      var r = hit.values, h = hit.h;
      res.attendee = {
        name: String(r[h['Attendee Name']] || ''),
        relationship: String(r[h['Relationship']] || ''),
        staff: String(r[h['Staff Name']] || ''),
        department: String(r[h['Department']] || ''),
        badgeId: String(r[h['Badge ID']] || ''),
        age: String(r[h['Age']] === undefined ? '' : r[h['Age']])
      };
    }
  }
  return res;
}

/**
 * Accepts the scanned QR text (WEB_APP_URL?t=TOKEN), a bare token, or a
 * typed Badge ID. Returns the upper-case QR Token (read-only lookup).
 */
function scannerApiToken_(code) {
  code = String(code || '').trim();

  var m = code.match(/[?&]t=([^&#]+)/);
  if (m) code = decodeURIComponent(m[1]);
  code = code.trim().toUpperCase();
  if (!code) return '';

  // Tokens from newToken_() are 16 upper-case hex characters.
  if (/^[0-9A-F]{16}$/.test(code)) return code;

  // Manual entry: Badge ID -> QR Token.
  var data = ss_().getSheetByName('Attendees').getDataRange().getValues();
  if (data.length < 2) return code;
  var h = headerMap_(data[0]);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][h['Badge ID']] || '').trim().toUpperCase() === code) {
      return String(data[i][h['QR Token']] || '').trim().toUpperCase();
    }
  }

  // Unknown: let recordBadgeAction report it as an invalid badge.
  return code;
}
