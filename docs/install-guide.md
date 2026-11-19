# Installing Pacekat

For the athlete. About 10 minutes, once. You need your Windows computer and your Garmin Connect login.

## 1. Run the installer

1. Download **Pacekat-Setup-0.1.0.exe** (the version number may be higher) from the link you were sent.
2. Double-click it.
3. Windows will probably show a blue box: **"Windows protected your PC"**. That's because the app isn't signed with a paid certificate, not because anything is wrong with it. Click **More info**, then **Run anyway**.
4. Pacekat installs itself (no admin password needed) and opens. You'll also find it on your Desktop and in the Start menu.

## 2. Create your Garmin key

Pacekat reads your data through Garmin's official "Personal API". You give it a key once; your password never goes into the app.

1. In a web browser, sign in to Garmin Connect and open this page: **https://connect.garmin.com/app/settings/personalApiToken**
2. Click **Create Key** and accept the terms.
3. For how long the key lasts, choose **1 year**, so you don't have to repeat this soon.
4. Copy the key. It starts with `GCDC_`. **Garmin shows it only once**, so copy it before you close the page. (If you lose it, just delete it there and create a new one.)

## 3. Connect

1. In Pacekat, paste the key and click **Connect**.
2. The first sync fetches your last 90 days. It takes a minute or two.
3. Click **Go to Today**. Done.

## Every day

- Sync your watch with the Garmin Connect phone app first, so last night's sleep and HRV are there.
- Open Pacekat. It syncs by itself when it opens; **Sync now** (top right) does it again.
- Today shows how recovered you are, what to do today, and your week.
- After a swim or a gym session, open it from **Latest** and tap how hard it felt (1–10). Heart rate is unreliable for those, so this keeps your training load right.

## Worth setting once (Races & Settings)

- **Races:** add your race and its priority (A = the one you're building toward). The plan builds toward your next A race.
- **My week:** your usual week. The app picks the sessions for each slot.
- **Body & zones:** your run threshold pace and swim CSS, if you know them. Sessions then show real target paces.
- **Hardware:** switch on what you use (chest strap, HRM 600 swim HR, running dynamics, bike power). The app also suggests these when it sees the data.

## Updates

Run the newer installer the same way. Your data stays.

## If something's wrong

- **"Garmin refused access" or the key expired:** Garmin emails you a week before the key expires. Create a new key (step 2), then **Races & Settings → Garmin → Replace key**.
- **"Couldn't reach Garmin":** check your internet connection; it tries again next time you open the app.
- **Backup:** **Races & Settings → Data & about → Export backup** saves everything to one zip file.
- **Where your data lives:** `%APPDATA%\pacekat` (paste that into File Explorer's address bar), or **Open data folder** in Settings. Uninstalling the app (Windows Settings → Apps) keeps this folder.

Pacekat gives training suggestions, not medical advice. If something hurts or feels wrong, rest and talk to a professional.

---

## For the developer: cutting a release

1. Bump `version` in `package.json` (e.g. `0.2.0`) and commit.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. GitHub Actions (`.github/workflows/ci.yml`) runs the tests on Linux and Windows, builds `Pacekat-Setup-0.2.0.exe`, `pacekat_0.2.0_amd64.deb` and `Pacekat-0.2.0.AppImage`, and attaches all three to a GitHub Release for that tag.
4. Every push to `main` also builds them; download from the workflow run's **Artifacts** to test before tagging.

Locally: `npm run dist:linux` builds the `.deb` and AppImage in `release/`. Install the `.deb` with `sudo apt install ./release/pacekat_0.2.0_amd64.deb`, or run the AppImage directly (`libfuse2` may be needed). The Windows installer is built in CI, since it needs Windows.
