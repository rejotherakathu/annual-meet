# Annual Day 2026 Volunteer Scanner (GitHub Pages)

A static phone scanner for volunteers at the **Entry gate** and **Meal counter**. It uses the existing **"Annual Day 2026 Gate Pass"** Apps Script and the **"Annual Day 2026 Gate pass"** sheet. All rules stay in that script: volunteer accounts, PIN check, roles, and the Entry Time / Meal Time / Activity writes.

```
Phone (GitHub Pages: index.html) ──POST text/plain JSON──▶ Apps Script doPost (ScannerApi.gs)
                                                             ├─ volunteerLogin()      VolunteerAuth.gs
                                                             ├─ recordBadgeAction()   WebApp.gs
                                                             └─ volunteerLogout()     VolunteerAuth.gs
```

| File | Purpose |
|---|---|
| `index.html` | Volunteer scanner page |
| `vendor/html5-qrcode.min.js` | QR scanning library, served from the repo (v2.3.8) |
| `apps-script/ScannerApi.gs` | **Required, additive** `doPost` adapter to add to the existing script project |

## Why `ScannerApi.gs` is needed

The production project has no `doPost`. Login and scan recording are only callable through `google.script.run`, which works only inside pages the script serves itself. A GitHub Pages site can only reach the script over HTTP, so it needs a `doPost`.

`ScannerApi.gs` adds it as a **new file**. **No existing function is changed:** `doGet`, `recordBadgeAction` and the badge-URL flow are untouched.
- **Login and logout:** the existing `volunteerLogin` / `volunteerLogout`.
- **Scan:** a new `scannerApiScan_` with the **same rules and writes** as `recordBadgeAction`:
  - checks the session and role (GATE → Entry, MEAL → Meal)
  - requires Status = `Active`
  - stamps Entry Time or Meal Time **only if empty**
  - logs successful scans to Activity through the existing `logActivity_`
  - returns the same messages (`ENTRY OK`, `ALREADY ENTERED`, `MEAL OK`, `MEAL ALREADY SERVED`, …)

## Many gates and meal counters: short lock

`recordBadgeAction` takes the script lock, then reads the whole Volunteers and Attendees tabs before writing. Every counter therefore waits in one queue for the whole scan, an estimated 1–3 s each (not measured).

`scannerApiScan_` keeps only the part that must be exclusive inside the lock:

| Step | Lock? | How |
|---|---|---|
| Session and role check | outside | session from the existing cache; Volunteers list cached 5 min |
| Find the badge row | outside | TextFinder on the QR Token column (then Badge ID), not a full-sheet read |
| Re-read that one row, check Entry/Meal Time, stamp if empty, flush | **inside** | ~one row read + one cell write |
| Activity row | outside | existing `logActivity_` |

**What stays the same:**
- **Duplicate protection is just as strict:** the "already served?" check and the stamp happen together under the same script lock that `recordBadgeAction` uses.
- **Sorted or inserted rows are safe:** inside the lock the row is re-verified, and searched again if it moved.

**What's new under load:**
- If the lock is busy for more than 10 s, the scan returns `SERVER_ERROR` and the phone keeps it and retries every 15 s. Scans are delayed, not lost.

**Trade-offs:**
- Deactivating a volunteer, or changing their role, takes effect within **5 minutes** (cache). `recordBadgeAction` applies it immediately.
- A failed Activity append no longer fails the scan, because the stamp is already saved. It's logged to the Apps Script executions log instead.
- Throughput isn't measured. Load-test with several phones on a copy before the event.

## How the page behaves (from the production script)

- **Sign-in:** Volunteer ID plus 6-digit PIN, checked by `volunteerLogin`. That uses the salted HMAC PIN hash in the Volunteers tab and the script's secret pepper, so the page never sees a hash. After 5 wrong PINs, the ID is locked out for 15 minutes. Sessions last 8 hours.
- **Role decides the gate:**
  - `GATE` volunteers record **Entry** (`gate`)
  - `MEAL` volunteers record **Meal** (`food`)
  - there's no gate picker; the server enforces the role
- **QR content:** `WEB_APP_URL?t=<QR Token>`, the URL printed on existing badges. The page extracts the token. If a QR won't scan, volunteers type the **Badge ID** printed under it.
- **What the volunteer sees:**
  - **Green:** ENTRY OK / MEAL OK
  - **Orange:** ALREADY ENTERED / MEAL ALREADY SERVED, with the first time
  - **Red:** NOT A VALID BADGE, or BADGE NOT ACTIVE (Status ≠ `Active`)
  - **Blue:** saved on the phone
- **Offline / server busy:** the scan is kept on the phone and retried every 15 s.
  - The server stamps the time the scan actually syncs, not the time it was scanned.
  - Queued scans sync only under a volunteer of the same role.
  - While offline, only duplicates on the same phone are caught.

## Go-live steps (in the production Apps Script project)

1. Add a new script file `ScannerApi.gs` with the contents of `apps-script/ScannerApi.gs`. Don't change other files.
2. **Deploy → Manage deployments → the deployment whose URL is `WEB_APP_URL` → ✏️ Edit → Version: New version → Deploy.** The URL stays the same, so printed badges keep working.
   - A new version publishes the project's current saved code, including any unfinished edits in other files. Check the project is in a releasable state first.
3. `SCRIPT_URL` in `index.html` is already set to `WEB_APP_URL` from `Config.gs`. If that deployment is not the one in step 2, update it.
4. Publish this branch with GitHub Pages and open it on a phone in Chrome or Safari.

## Not tested

This branch was written from a read-only review of the production script. Nothing was run against production. Before event day, do a dry run on a **copy** of the sheet and its script: sign-in, Entry, Meal, duplicate, inactive badge, unknown QR, Badge ID entry, and airplane mode.
