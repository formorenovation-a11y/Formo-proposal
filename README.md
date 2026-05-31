# Formo Proposal Studio

AI-powered proposal generator for Formo Renovation LLC.  
Generate stunning client proposals with before/after photos, renderings, and built-in client engagement tracking.

---

## Features

- **AI-Generated Proposals** — Enter your scope and budget, Claude writes a premium HTML proposal
- **Image Upload** — Before/after photos, 3D renders, project photos
- **Client Tracking** — Know exactly when your client opens the proposal and how long they read it
- **Dashboard** — See all sent proposals with open rates and time-on-page
- **Shareable Links** — Send a single URL; no downloads needed

---

## Local Development

```bash
git clone https://github.com/YOUR_ORG/formo-proposal-studio.git
cd formo-proposal-studio
npm install
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env
npm run dev
# Open http://localhost:3000
```

---

## Deploy to Render

### Option A — via render.yaml (recommended)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Blueprint
3. Connect your GitHub repo
4. Render reads `render.yaml` automatically
5. Add `ANTHROPIC_API_KEY` in Environment Variables
6. Deploy

### Option B — Manual

1. New Web Service → Connect repo
2. **Build Command:** `npm install`
3. **Start Command:** `npm start`
4. **Environment Variables:**
   - `ANTHROPIC_API_KEY` = your key
   - `NODE_ENV` = production
5. Add a **Disk** (Render > Disks):
   - Mount path: `/app/proposals`
   - Size: 1 GB
6. Deploy

> ⚠️ The free Render plan has ephemeral storage — proposals reset on redeploy.  
> Use a paid plan + persistent disk or add a database for production use.

---

## How to Use

### Creating a Proposal

1. Open the app → **New Proposal** tab
2. Fill in client name, project title, address
3. Add scope items (each becomes a section)
4. Add line items with amounts (auto-totals)
5. Upload images (renders, before/after, project photos)
6. Click **Generate Proposal** — Claude builds the full HTML
7. Copy the link and send to your client

### Tracking Client Engagement

- Go to **Dashboard** tab
- See all proposals with open count, total time viewed, last seen date
- Click any card for session-by-session breakdown
- Green badge = opened, gray = not yet opened

---

## Stack

- **Backend:** Node.js + Express
- **AI:** Anthropic Claude (claude-opus-4-5)
- **Storage:** Local filesystem (upgradeable to S3/Supabase)
- **Hosting:** Render
- **Frontend:** Vanilla JS + CSS (no framework needed)
