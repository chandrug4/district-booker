# PVR Pondicherry — District Seat Checker

Checks seat availability at **PVR Providence Mall, Pondicherry** via District app and emails you when your movie opens for booking.

## Features
- Watches any movie at PVR Pondicherry (by name + language)
- **Smart DOM Extraction:** Scrapes movie titles directly from the page layout before checking seats
- **Side-by-Side Adjacent Seats:** Selects contiguous seats together in the exact same row for you and your friends
- **Parallel Chunking:** Scrapes multiple showtimes concurrently using Playwright (`MAX_CONCURRENCY=3`)
- **Time Window Filtering:** Restrict checking to specific time windows (e.g. `START_TIME=09:00`, `END_TIME=11:00`)
- **Authenticated Playwright UI Auto-Hold:** Auto-holds seats under your account, dismisses modals, skips F&B, and emails a direct 10-minute `/order-review/` payment link
- **Transaction Protection:** Limits auto-holding to 1 active hold per run to prevent District from canceling your active 10-minute hold
- **Digest Email Option:** Combine alerts for multiple shows into one summary email (`CONSOLIDATE_ALERTS=true`)

---

## Setup

### Step 1 — GitHub Actions permissions
Settings → Actions → General → Workflow permissions → **Read and write permissions** → Save

### Step 2 — Set Variables
Settings → Secrets and variables → Actions → **Variables**

| Variable | Example | Description |
|---|---|---|
| `CINEMA_URL_BASE` | `https://www.district.in/movies/pvr-providence-mall-providence-mall-pondicherry-in-puducherry-CD1025204` | District cinema page URL |
| `TARGET_MOVIE` | `Jana Nayagan` | Movie name (partial match ok) |
| `WATCH_LANGUAGE` | `Tamil` | Language filter (Tamil / Hindi / English) |
| `WATCH_DATES` | `2026-08-01` | Specific dates (comma-separated YYYY-MM-DD) |
| `NUM_TICKETS` | `2` | How many tickets you want |
| `PREFERRED_AREA` | `EL` | EL = Elite, PR = Premium |
| `MIN_SEATS` | `2` | Alert only when this many seats free |
| `START_TIME` | `09:00` | Optional start time filter (e.g., 09:00) |
| `END_TIME` | `11:00` | Optional end time filter (e.g., 11:00) |
| `MAX_CONCURRENCY` | `3` | Parallel browser tabs count (default: 3) |
| `CONSOLIDATE_ALERTS` | `true` | Combine multiple shows into 1 email (default: true) |

### Step 3 — Set Secrets
Settings → Secrets and variables → Actions → **Secrets**

| Secret | Where to get it |
|---|---|
| `TO_EMAIL` | Your email address |
| `EMAILJS_SERVICE_ID` | EmailJS → Email Services |
| `EMAILJS_TEMPLATE_ID` | EmailJS → Email Templates (ticket-open) |
| `EMAILJS_FAILURE_TEMPLATE_ID` | EmailJS → Email Templates (failure) |
| `EMAILJS_PUBLIC_KEY` | EmailJS → Account |
| `EMAILJS_PRIVATE_KEY` | EmailJS → Account → Security |
| `DISTRICT_COOKIES` | Full cookie string from browser for Auto-Hold (see below) |

---

## Option B — Auto Seat-Hold (Send Direct Payment Link)

Add `DISTRICT_COOKIES` secret:
1. Open **district.in** in your web browser → Login to your account
2. Press **F12** → Network tab → click any `/gw/` request
3. In **Request Headers** → copy the entire `cookie:` line (includes `x-device-id`, `location`, `x-access-token`, `x-refresh-token`, `userProfile`)
4. Paste as `DISTRICT_COOKIES` secret in GitHub Secrets

When set, Playwright will:
- Authenticate as you in Playwright UI
- Target exact side-by-side adjacent seats in your preferred row
- Dismiss promotional modals & skip F&B popups
- Reserve your seats on District's servers (holding them for 10 minutes)
- Send you a direct `/order-review/` payment link in your email!

---

## Local Testing

```bash
npm install
npm run browsers
cp .env.example .env
# fill in .env with your values
node --env-file=.env check.js
```
