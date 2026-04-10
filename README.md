# Harmonic Deal Tracker

Polls [Harmonic](https://harmonic.ai) for newly announced funding rounds and sends formatted alerts to a Slack channel. Runs automatically on a schedule via GitHub Actions.

**Filters:**
- 🇺🇸 US-based companies only
- 💰 Seed, Series A, Series B
- 🚫 Excludes Biotech / Life Sciences
- ✅ Deduplication — only alerts on companies not seen before

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/harmonic-deal-tracker.git
cd harmonic-deal-tracker
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Required | Description |
|---|---|---|
| `HARMONIC_API_KEY` | ✅ | Found at [console.harmonic.ai/dashboard/settings/api](https://console.harmonic.ai/dashboard/settings/api) |
| `SLACK_BOT_TOKEN` | ✅ | `xoxb-...` token from your Slack app |
| `SLACK_CHANNEL` | ✅ | e.g. `#deal-alerts` |
| `MIN_ROUND_SIZE_M` | optional | Minimum round size in $M |
| `MAX_ROUND_SIZE_M` | optional | Maximum round size in $M |
| `MIN_EMPLOYEES` | optional | Minimum headcount |

### 3. Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → From scratch
2. Under **OAuth & Permissions** → add scope: `chat:write`
3. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-...`)
4. Invite the bot to your channel: `/invite @your-bot-name`

### 4. Run locally

```bash
npm start
```

---

## Automated scheduling (GitHub Actions)

The workflow in `.github/workflows/deal-tracker.yml` runs automatically **twice per weekday** (8am and 2pm ET). You can also trigger it manually from the **Actions** tab.

### Add secrets to GitHub

Go to your repo → **Settings → Secrets and variables → Actions** → add:

- `HARMONIC_API_KEY`
- `SLACK_BOT_TOKEN`
- `SLACK_CHANNEL`
- `MIN_ROUND_SIZE_M` *(optional)*
- `MAX_ROUND_SIZE_M` *(optional)*
- `MIN_EMPLOYEES` *(optional)*

### Change the schedule

Edit the `cron` expressions in `.github/workflows/deal-tracker.yml`:

```yaml
- cron: "0 12 * * 1-5"   # 8am ET weekdays
- cron: "0 18 * * 1-5"   # 2pm ET weekdays
```

---

## How it works

1. Queries Harmonic's search API with your stage/geo filters
2. Applies local filters (sector exclusions, round size, headcount)
3. Deduplicates against `data/seen_companies.json` — only new companies trigger alerts
4. Posts a formatted Slack message with company name, stage, round size, headcount, description, and links
5. Saves newly seen companies to avoid repeat alerts

---

## Customising filters

Edit the `FILTERS` object at the top of `src/tracker.js`:

```js
const FILTERS = {
  stages: ["Seed", "Series A", "Series B"],
  geography: "United States",
  excludeSectors: ["Biotech", "Life Sciences", "Pharmaceuticals", "Healthcare"],
  minRoundSizeM: null,
  maxRoundSizeM: null,
  minEmployees: null,
};
```
