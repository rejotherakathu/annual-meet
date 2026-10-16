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

`ScannerApi.gs` adds that and nothing else:
- **No existing function is changed** and `doGet` is untouched.
- **The only write is the existing `recordBadgeAction`:** it stamps Entry Time or Meal Time and appends to Activity, with Scan Source `Volunteer Scanner`.
- **Two extra reads:**
  - a typed Badge ID is looked up to find its QR Token
  - after a scan, the attendee's name, relationship and department are read for display

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
  - `recordBadgeAction` stamps the time it actually syncs, not the time it was scanned.
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
