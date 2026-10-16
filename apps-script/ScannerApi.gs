/**
 * Annual Day 2026 - JSON API for the GitHub Pages volunteer scanner.
 *
 * ADD THIS AS A NEW FILE in the existing "Annual Day 2026 Gate Pass" project.
 * It changes no existing function; doGet and recordBadgeAction are untouched.
 *
 *   login  -> volunteerLogin(id, pin)      VolunteerAuth.gs (unchanged)
 *   logout -> volunteerLogout(session)     VolunteerAuth.gs (unchanged)
 *   scan   -> scannerApiScan_ (below)      same rules and writes as recordBadgeAction,
 *                                          but holds the script lock only for the
 *                                          check-and-stamp of a single cell
 *
 * Writes (identical to recordBadgeAction):
 *   - Attendees "Entry Time" (gate) or "Meal Time" (food): only when empty
 *   - Activity: one row per successful scan, via the existing logActivity_
 *
 * Why the short lock: recordBadgeAction takes the lock, then reads the whole
 * Volunteers and Attendees tabs before writing, so every gate and meal counter
 * queues behind one another for the full duration. Here the session check and
 * badge lookup happen outside the lock; inside it we re-read one row, check the
 * cell, write it, and flush. Duplicate protection across all counters is the
 * same, because the check and the write still happen together under the lock.
 * recordBadgeAction uses the same script lock, so both paths stay consistent.
 *
 * The scanner POSTs JSON as text/plain (no custom headers), which avoids the
 * CORS preflight that Apps Script cannot answer.
 */

var SCANNER_API = {
  LOCK_WAIT_MS: 10000,          // busy longer than this → SERVER_ERROR; the phone keeps the scan and retries
  VOLUNTEER_CACHE_SECONDS: 300  // Status/Role changes in the Volunteers tab apply within 5 minutes
};

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
    console.error(err && err.stack || err);
    out = { ok: false, result: 'SERVER_ERROR', message: String((err && err.message) || err) };
  }

  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Scan
//   result: OK | DUPLICATE | BLOCKED | NOT_FOUND | SESSION | ERROR | SERVER_ERROR
//   plus recordBadgeAction's fields: message, entered, meal, entryText, mealText
// ---------------------------------------------------------------------------
function scannerApiScan_(req) {
  var action = req.action === 'gate' || req.action === 'food' ? req.action : '';
  if (!action) {
    return { ok: false, result: 'ERROR', message: 'Invalid scanning action' };
  }

  // 1. Session (outside the lock; volunteer list cached).
  var auth = scannerApiSession_(req.session, action);
  if (!auth.ok) {
    return {
      ok: false,
      result: auth.message === 'Not authorized for this scanning action' ? 'ERROR' : 'SESSION',
      message: auth.message
    };
  }

  // 2. Find the badge row (outside the lock; searches one column, not the whole sheet).
  var sh = ss_().getSheetByName('Attendees');
  var lastCol = sh.getLastColumn();
  var h = headerMap_(sh.getRange(1, 1, 1, lastCol).getValues()[0]);
  var code = scannerApiCode_(req.code);
  var row = code ? scannerApiFindRow_(sh, h, code) : 0;
  if (!row) {
    return { ok: false, result: 'NOT_FOUND', message: 'Invalid badge' };
  }

  var col = action === 'gate' ? 'Entry Time' : 'Meal Time';
  var r, msg, wrote = false;

  // 3. Check-and-stamp (inside the lock: one row read, one cell write).
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(SCANNER_API.LOCK_WAIT_MS)) {
    return { ok: false, result: 'SERVER_ERROR', message: 'Server busy, retrying' };
  }
  try {
    r = sh.getRange(row, 1, 1, lastCol).getValues()[0];
    if (!scannerApiRowMatches_(r, h, code)) {
      // Rows were sorted or inserted since the search: find it again under the lock.
      row = scannerApiFindRow_(sh, h, code);
      if (!row) return { ok: false, result: 'NOT_FOUND', message: 'Invalid badge' };
      r = sh.getRange(row, 1, 1, lastCol).getValues()[0];
    }

    if (String(r[h['Status']]) !== 'Active') {
      msg = 'Badge is not active';
    } else if (r[h[col]]) {
      msg = action === 'gate' ? 'ALREADY ENTERED' : 'MEAL ALREADY SERVED';
    } else {
      var now = new Date();
      sh.getRange(row, h[col] + 1).setValue(now);
      SpreadsheetApp.flush(); // visible to the next scan before the lock is released
      r[h[col]] = now;
      msg = action === 'gate' ? 'ENTRY OK' : 'MEAL OK';
      wrote = true;
    }
  } finally {
    lock.releaseLock();
  }

  // 4. Activity log (outside the lock; same row format and same "log successful
  //    scans only" behaviour as recordBadgeAction).
  if (wrote) {
    try {
      logActivity_(r, h, action, msg, auth.volunteerId, auth.role);
    } catch (err) {
      console.error('Activity log failed: ' + (err && err.stack || err)); // the stamp is already saved
    }
  }

  var attendee = {
    name: String(r[h['Attendee Name']] || ''),
    relationship: String(r[h['Relationship']] || ''),
    staff: String(r[h['Staff Name']] || ''),
    department: String(r[h['Department']] || ''),
    badgeId: String(r[h['Badge ID']] || ''),
    age: String(r[h['Age']] === undefined ? '' : r[h['Age']])
  };

  if (msg === 'Badge is not active') {
    return { ok: false, result: 'BLOCKED', message: msg, attendee: attendee };
  }
  var state = badgeState_(r, h, msg); // existing helper: entered/meal flags and times
  state.ok = true;
  state.result = wrote ? 'OK' : 'DUPLICATE';
  state.attendee = attendee;
  return state;
}

/**
 * Same checks and messages as validateVolunteerSession_, but the Volunteers
 * tab is cached instead of read on every scan.
 */
function scannerApiSession_(sessionToken, action) {
  sessionToken = String(sessionToken || '').trim();
  if (!/^[0-9a-fA-F-]{72}$/.test(sessionToken)) {
    return { ok: false, message: 'Invalid volunteer session' };
  }

  var cache = CacheService.getScriptCache();
  var stored = cache.get('VOL_SESSION_' + sessionToken);
  if (!stored) {
    return { ok: false, message: 'Session expired. Please log in again.' };
  }
  var session = JSON.parse(stored);

  var roles = cache.get('SCANNER_API_VOL_ROLES');
  if (roles) {
    roles = JSON.parse(roles);
  } else {
    roles = {};
    var data = ss_().getSheetByName('Volunteers').getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var id = String(data[i][0]).trim().toUpperCase();
      if (id && String(data[i][4]).trim().toUpperCase() === 'ACTIVE') {
        roles[id] = String(data[i][2]).trim().toUpperCase();
      }
    }
    cache.put('SCANNER_API_VOL_ROLES', JSON.stringify(roles), SCANNER_API.VOLUNTEER_CACHE_SECONDS);
  }

  var activeRole = roles[session.volunteerId] || '';
  if (activeRole !== session.role) {
    return { ok: false, message: 'Volunteer account is inactive or changed' };
  }
  if ((action === 'gate' && activeRole !== 'GATE') || (action === 'food' && activeRole !== 'MEAL')) {
    return { ok: false, message: 'Not authorized for this scanning action' };
  }
  return { ok: true, volunteerId: session.volunteerId, role: session.role };
}

/** QR text (WEB_APP_URL?t=TOKEN), a bare token, or a typed Badge ID → upper-case code. */
function scannerApiCode_(code) {
  code = String(code || '').trim();
  var m = code.match(/[?&]t=([^&#]+)/);
  if (m) {
    try { code = decodeURIComponent(m[1]); } catch (e) { code = m[1]; }
  }
  return code.trim().toUpperCase();
}

/** Row number by QR Token, else by Badge ID (both case-insensitive, whole cell). 0 if none. */
function scannerApiFindRow_(sh, h, code) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  var cols = ['QR Token', 'Badge ID'];
  for (var i = 0; i < cols.length; i++) {
    if (h[cols[i]] === undefined) continue;
    var cell = sh.getRange(2, h[cols[i]] + 1, n, 1)
      .createTextFinder(code)
      .matchEntireCell(true)
      .matchCase(false)
      .findNext();
    if (cell) return cell.getRow();
  }
  return 0;
}

function scannerApiRowMatches_(r, h, code) {
  return String(r[h['QR Token']] || '').trim().toUpperCase() === code ||
    String(r[h['Badge ID']] || '').trim().toUpperCase() === code;
}
