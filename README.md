# ClockIn&Out

A small Progressive Web App for clocking in and out of work. Track a main **Daily work** task plus optional extra tasks, edit recent shifts, correct older locked records, and export a CSV for pay claims. Data stays in this browser on this device (`localStorage`).

## Deploy to GitHub Pages

1. Create a GitHub repository and push the contents of this `app/` folder to it (or put them at the repo root).
2. On GitHub: **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Choose your branch (usually `main`) and folder **/ (root)**, then Save.
5. After a minute or two, open the Pages URL GitHub shows. Relative asset paths work under a project subpath too (e.g. `https://USER.github.io/REPO/`).

## Install on a phone

**iPhone (Safari)**  
Open the Pages URL in Safari → Share → **Add to Home Screen**.

**Android (Chrome)**  
Open the Pages URL in Chrome → menu → **Install app** (or Add to Home screen).

## Features in short

- Clock In / Clock Out for Daily work, with a live clock while a shift is running
- Start another task from the corner button; extra task names are remembered
- Overnight shifts (`+1 day` when clock-out is earlier than clock-in)
- Edit or delete records from the last 7 days; older records are locked (hours correction only)
- Week (Mon–Sun) and month totals per task, with overlap noted for extra tasks
- Export one task at a time (save a CSV, or send it)
- A brief How to under the **?** icon, and a coming-soon Teams page under the sparkle icon

## In-app news

To show a one-time message when the app opens, edit `news.json` in this folder:

```json
{"messages":[{"id":"2026-11-welcome","title":"New: Manager version","body":"Managers can now invite staff with a QR code or link. Your side jobs still stay private on your phone."}]}
```

Each message `id` is shown once per device. Use a new `id` for a new announcement. Leave `"messages": []` for no news.
