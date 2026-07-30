# PVR Pondicherry — District Seat Checker

Checks seat availability at **PVR Providence Mall, Pondicherry** via District app and emails you when your movie opens for booking.

## Features
- Watches any movie at PVR Pondicherry (by name + language)
- Shows available seats per category (Elite / Premium) with prices
- Suggests best N consecutive seats
- Optional: auto-holds seats and sends you a direct payment link
- Runs every 15 minutes via GitHub Actions

## Setup

### Step 1 — Fork / clone this repo

### Step 2 — GitHub Actions permissions
Settings → Actions → General → Workflow permissions → **Read and write permissions** → Save

### Step 3 — Set Variables
Settings → Secrets and variables → Actions → **Variables**

| Variable | Example | Description |
|---|---|---|
| `CINEMA_URL_BASE` | `https://www.district.in/movies/pvr-providence-mall-providence-mall-pondicherry-in-puducherry-CD1025204` | District cinema page URL |
| `TARGET_MOVIE` | `Jana Nayagan` | Movie name (partial match ok) |
| `WATCH_LANGUAGE` | `Tamil` | Language filter (Tamil / Hindi / English) |
| `WATCH_DATES` | `2026-07-31` | Specific dates (comma-separated YYYY-MM-DD) |
| `NUM_TICKETS` | `2` | How many tickets you want |
| `PREFERRED_AREA` | `EL` | EL = Elite, PR = Premium |
| `MIN_SEATS` | `2` | Alert only when this many seats free |

### Step 4 — Set Secrets
Settings → Secrets and variables → Actions → **Secrets**

| Secret | Where to get it |
|---|---|
| `TO_EMAIL` | Your email address |
| `EMAILJS_SERVICE_ID` | EmailJS → Email Services |
| `EMAILJS_TEMPLATE_ID` | EmailJS → Email Templates (ticket-open) |
| `EMAILJS_FAILURE_TEMPLATE_ID` | EmailJS → Email Templates (failure) |
| `EMAILJS_PUBLIC_KEY` | EmailJS → Account |
| `EMAILJS_PRIVATE_KEY` | EmailJS → Account → Security |
| `DISTRICT_ACCESS_TOKEN` | Optional — for auto seat-hold (see below) |

### Step 5 — EmailJS Setup
1. Sign up at **emailjs.com** (free)
2. Email Services → Add New Service → Gmail → Connect → Send Test
3. Email Templates → Create New Template:
   - To Email: `{{to_email}}`
   - Subject: `{{subject}}`
   - Body: `{{message}}`
   - Save → copy Template ID → this is `EMAILJS_TEMPLATE_ID`
4. Create a second template (same format) → `EMAILJS_FAILURE_TEMPLATE_ID`
5. Account page → copy **Public Key** → `EMAILJS_PUBLIC_KEY`
6. Account → Security → enable API → copy **Private Key** → `EMAILJS_PRIVATE_KEY`

### Step 6 — Run manually
Actions tab → **Check PVR Pondicherry Availability** → Run workflow → Run workflow

---

## Option B — Auto seat-hold (send direct payment link)

Add `DISTRICT_ACCESS_TOKEN` secret:
1. Open **district.in** in Chrome → Login to your account
2. Open any movie → open seat layout page
3. Press **F12** → Network tab → filter by `/gw/`
4. Click any `/gw/consumer/movies/...` request
5. In **Request Headers** → copy `x-access-token` value
6. Paste as `DISTRICT_ACCESS_TOKEN` secret in GitHub

When set, the checker will:
- Auto-select your N best consecutive seats
- Send you a **direct payment link** in the email
- You just tap Pay — done!

Token expires ~30 days. Update when it stops working.

---

## Seat Status Reference

| Status in API | Meaning |
|---|---|
| `"0"` | ✅ Available |
| `"0"` + bestSeat | ✅ Available (Best Seat — blue) |
| `"1"` | ❌ Booked/Taken |
| `"1000"` | ♿ Wheelchair companion |
| `"1001"` | ♿ Wheelchair seat |

---

## Schedule

Runs every 15 minutes at :02, :17, :32, :47 automatically once pushed.

To pause: add variable `STOP` = `1`
To resume: delete the `STOP` variable

---

## Local Testing

```bash
npm install
npm run browsers
cp .env.example .env
# fill in .env with your values
node --env-file=.env check.js
```
