import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import {
  windowsUserAgent, launchArgs, contextOptions, stealthInitScript,
  probeClientHints, fixAcceptLanguage, actHuman, rand
} from './stealth.js';
import { buildProfile, describeProfile } from './fingerprint.js';
import { extractInitialState, analyseState } from './extract.js';

// The event code in this URL is the IMAX 2D event (the-odyssey-imax-2d), so a
// date going on sale on this page is IMAX going on sale.
const BASE_URL = (process.env.TARGET_URL_BASE ||
  'https://in.bookmyshow.com/movies/chennai/the-odyssey/buytickets/ET00480917')
  .replace(/\/+$/, '');

const STATE_FILE = 'state.json';
const DEBUG_DIR = 'debug';

// Kill switch. Any non-empty value pauses the checker whatever the caller is -
// an external cron, the Actions schedule, a manual run. The value is never
// interpreted, only its presence: STOP=0 pauses just like STOP=1, because
// "set means stopped" is the rule you can remember at 2am. Delete or blank it
// to resume.
const STOP = (process.env.STOP || '').trim();

// Which weekday to watch, as a name ("monday") or a number (0=Sunday..6=Saturday).
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday',
                       'thursday', 'friday', 'saturday'];

function parseWeekday(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const raw = String(value).trim().toLowerCase();
  if (/^\d$/.test(raw)) return Number(raw);
  const i = WEEKDAY_NAMES.findIndex((n) => n.startsWith(raw));
  if (i === -1) throw new Error(`WATCH_WEEKDAY: not a weekday: "${value}"`);
  return i;
}

const WATCH_WEEKDAY = parseWeekday(process.env.WATCH_WEEKDAY, 1);   // Monday

// Pin specific dates instead of a weekday, e.g. "2026-08-15,2026-08-22".
// Set, it wins over WATCH_WEEKDAY/DATES_TO_CHECK; blank, the weekday rule runs.
const WATCH_DATES = (process.env.WATCH_DATES || '').trim();

// BookMyShow only publishes ~7 days, so dates beyond the second read
// "not in booking window yet" until they come into range.
const DATES_TO_CHECK = Number(process.env.DATES_TO_CHECK || 2);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
const PROXY_URL = process.env.PROXY_URL || '';

const FINGERPRINT_SEED = process.env.FINGERPRINT_SEED ||
  (process.env.GITHUB_RUN_ID &&
    `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || 1}`) ||
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Consecutive blind runs before the failure alert fires. Counts any run that
// could not read availability, not just HTTP blocks.
const BLOCK_ALERT_THRESHOLD = Number(process.env.BLOCK_ALERT_THRESHOLD || 3);

// Separate EmailJS templates so a "checker is broken" mail looks different
// from a "tickets are open" mail in the inbox.
const TEMPLATE_ALERT = process.env.EMAILJS_TEMPLATE_ID;
const TEMPLATE_FAILURE =
  process.env.EMAILJS_FAILURE_TEMPLATE_ID;

// --- state ------------------------------------------------------------------

function loadState() {
  try {
    const p = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      notified: p.notified || {},
      consecutiveBlocks: p.consecutiveBlocks || 0,
      blockAlertSent: p.blockAlertSent || false,
      lastRun: p.lastRun || null
    };
  } catch {
    return { notified: {}, consecutiveBlocks: 0, blockAlertSent: false, lastRun: null };
  }
}

function saveState(state) {
  state.lastRun = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// --- dates (IST, the timezone BookMyShow's date codes are in) ----------------

function todayIST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

/**
 * Upcoming dates that fall on `weekday`, starting with the coming one. Today
 * counts if it already is that weekday - the day's shows are still bookable.
 */
function nextWeekdays(weekday, count) {
  const [y, m, d] = todayIST().split('-').map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));   // UTC: no DST, no off-by-one
  const out = [];
  while (out.length < count) {
    if (cursor.getUTCDay() === weekday) out.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Explicit dates from WATCH_DATES: comma-separated, YYYY-MM-DD or YYYYMMDD.
 *
 * Rejects rather than silently rounds a date that does not exist (a "31st" of
 * a 30-day month), because a typo here means the checker watches the wrong day
 * and never says so.
 */
function parseWatchDates(spec) {
  const out = spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
    if (!m) throw new Error(`WATCH_DATES: not a YYYY-MM-DD date: "${s}"`);
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (urlDate(d) !== `${m[1]}${m[2]}${m[3]}`) {
      throw new Error(`WATCH_DATES: no such date: "${s}"`);
    }
    return d;
  });
  if (out.length === 0) throw new Error('WATCH_DATES is set but lists no dates');
  return out.sort((a, b) => a - b);
}

const urlDate = (d) =>
  `${d.getUTCFullYear()}` +
  `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
  `${String(d.getUTCDate()).padStart(2, '0')}`;

const humanDate = (d) => d.toLocaleDateString('en-IN', {
  timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
});

// --- notification -----------------------------------------------------------

async function sendEmail(templateId, subject, message) {
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: process.env.EMAILJS_SERVICE_ID,
      template_id: templateId,
      user_id: process.env.EMAILJS_PUBLIC_KEY,
      accessToken: process.env.EMAILJS_PRIVATE_KEY,
      template_params: { subject, message, to_email: process.env.TO_EMAIL }
    })
  });
  if (!res.ok) throw new Error(`EmailJS ${res.status}: ${await res.text()}`);
}

/** Tickets are open. Failing here should fail the run - it is the whole point. */
async function notifyAvailable(subject, message) {
  await sendEmail(TEMPLATE_ALERT, subject, message);
  console.log('   alert email sent');
}

/** Link back to the run that produced this, when running in Actions. */
function workflowRunUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL || 'https://github.com'}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : null;
}

/**
 * The checker is blind. Best-effort: a failure to deliver this must not mask
 * the underlying failure we are trying to report.
 */
async function notifyBlocked(runs, reason) {
  const runUrl = workflowRunUrl();
  const body = [
    `The IMAX checker has failed to read the page on ${runs} runs in a row.`,
    `It is not currently able to tell whether tickets have opened.`,
    ``,
    `Last reason: ${reason}`,
    ``,
    runUrl ? `Check the workflow run: ${runUrl}` : `Check the workflow run in the Actions tab.`,
    `The run's "debug-artifacts" download has a screenshot and the raw HTML of`,
    `exactly what came back.`,
    ``,
    `Meanwhile, check by hand: ${BASE_URL}`
  ].join('\n');

  try {
    await sendEmail(TEMPLATE_FAILURE, `IMAX checker is blocked (${runs} runs)`, body);
    console.log('   failure email sent');
    return true;
  } catch (e) {
    console.error('   failure email could not be sent:', e.message);
    return false;
  }
}

// --- block detection --------------------------------------------------------

const BLOCK_SIGNALS = [
  /sorry, you have been blocked/i,
  /attention required/i,
  /access denied/i,
  /just a moment/i,
  /checking your browser/i,
  /verify (you are|you're) (a )?human/i,
  /captcha/i,
  /cloudflare ray id/i,
  /unusual traffic/i
];

function classifyBlock(status, html) {
  if (status === 403 || status === 429 || status === 503) return `HTTP ${status}`;
  const hit = BLOCK_SIGNALS.find((re) => re.test(html.slice(0, 8000)));
  return hit ? `challenge/block page (${hit})` : null;
}

async function dumpDebug(page, label) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const safe = label.replace(/[^\w.-]+/g, '_');
    await page.screenshot({ path: path.join(DEBUG_DIR, `${safe}.png`), fullPage: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `${safe}.html`), await page.content());
    console.log(`   wrote ${DEBUG_DIR}/${safe}.{png,html}`);
  } catch (e) {
    console.error('   could not write debug artifacts:', e.message);
  }
}

// --- fetch ------------------------------------------------------------------

/**
 * The window size is a launch flag, so the browser is launched per attempt
 * rather than once per run - a retry that reuses the blocked attempt's window
 * geometry is only half a new machine.
 */
async function launchBrowser(profile) {
  const opts = {
    headless: true,
    args: launchArgs(profile),
    ...(PROXY_URL ? { proxy: { server: PROXY_URL } } : {})
  };
  try {
    const b = await chromium.launch({ ...opts, channel: 'chrome' });
    console.log(`   Google Chrome ${b.version()}`);
    return b;
  } catch {
    const b = await chromium.launch(opts);
    console.log(`   bundled Chromium ${b.version()} (Chrome channel unavailable)`);
    return b;
  }
}

/**
 * Load the showtimes page once.
 *
 * Do not add a homepage warm-up. Visiting the homepage first makes Cloudflare
 * issue a bot-management cookie that gets the next request 403'd; going
 * straight to the target on a cold context returns 200. Each attempt therefore
 * uses a brand-new browser and context so no cookie is ever carried over.
 *
 * Each attempt also draws a *different* hardware profile: retrying a block with
 * the fingerprint that was just refused is the one thing guaranteed not to
 * help.
 */
async function fetchPage() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const profile = buildProfile(`${FINGERPRINT_SEED}#${attempt}`);
    console.log(`\n   attempt ${attempt}/${MAX_ATTEMPTS}`);
    console.log(`   posing as: ${describeProfile(profile)}`);

    const browser = await launchBrowser(profile);

    // The UA has to be built from the browser that actually launched, so the
    // major version in the UA string matches the engine behind it.
    profile.chromeVersion = browser.version();
    const userAgent = windowsUserAgent(profile.chromeVersion);

    // Client-hint brands come from the browser itself, with "HeadlessChrome"
    // rewritten. Has to happen before the real context exists, because
    // extraHTTPHeaders are fixed at context creation.
    profile.uaBrands = await probeClientHints(browser);

    const context = await browser.newContext(contextOptions(profile, userAgent));
    await fixAcceptLanguage(context, profile);
    await context.addInitScript(stealthInitScript, profile);
    const page = await context.newPage();

    try {
      const res = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const status = res?.status() ?? 0;
      await page.waitForTimeout(rand(2500, 4500));
      await actHuman(page, profile);

      const html = await page.content();
      const block = classifyBlock(status, html);

      if (block) {
        console.log(`   blocked: ${block}`);
        await dumpDebug(page, `blocked-attempt${attempt}`);
        await browser.close();
        if (attempt < MAX_ATTEMPTS) {
          const backoff = rand(8000, 20000) * attempt;
          console.log(`   backing off ${Math.round(backoff / 1000)}s`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        return { blocked: true, reason: block };
      }

      console.log(`   loaded ok (HTTP ${status}, ${html.length} bytes)`);
      await browser.close();
      return { blocked: false, html };
    } catch (e) {
      console.log(`   error: ${e.message}`);
      await dumpDebug(page, `error-attempt${attempt}`).catch(() => {});
      await browser.close().catch(() => {});
      if (attempt === MAX_ATTEMPTS) {
        return { blocked: true, reason: `navigation error: ${e.message}` };
      }
      await new Promise((r) => setTimeout(r, rand(5000, 12000) * attempt));
    }
  }
}

// --- main -------------------------------------------------------------------

async function main() {
  // Before anything else: no page load, no email, no state write, exit 0 so a
  // paused checker never looks like a broken one to cron or to Actions.
  if (STOP) {
    console.log(`STOPPED - the STOP variable is set (STOP=${STOP}).`);
    if (/^(0|false|no|off)$/i.test(STOP)) {
      console.log('Note: the value is ignored - being set at all is what pauses it.');
    }
    console.log('Nothing was checked; state.json was left untouched.');
    console.log('Delete the STOP variable to resume.');
    return;
  }

  const state = loadState();
  const watchDates = WATCH_DATES
    ? parseWatchDates(WATCH_DATES)
    : nextWeekdays(WATCH_WEEKDAY, DATES_TO_CHECK);

  const today = todayIST();
  console.log(`Today (IST): ${today}`);
  console.log(`Watching:    ${watchDates.map(humanDate).join(', ')}` +
    (WATCH_DATES ? '  (pinned via WATCH_DATES)' : ''));

  // A pinned date that has passed can never go on sale, so the run would look
  // healthy forever while watching nothing. Say so loudly.
  const stale = watchDates.filter((d) => urlDate(d) < today.replace(/-/g, ''));
  if (stale.length) {
    console.warn(`\nWARNING: ${stale.map(humanDate).join(', ')} ` +
      `${stale.length > 1 ? 'are' : 'is'} in the past - update WATCH_DATES.`);
  }
  if (PROXY_URL) console.log('Using proxy from PROXY_URL');

  console.log(`\nLoading ${BASE_URL}`);
  const fetched = await fetchPage();

  // Every way of ending up unable to read availability funnels through here,
  // so a page that loads but no longer parses raises the alarm just like a 403.
  async function blindRun(reason) {
    state.consecutiveBlocks++;
    console.error(`\nCOULD NOT READ AVAILABILITY - ${reason}`);
    console.error(`Consecutive failed runs: ${state.consecutiveBlocks}`);

    if (state.consecutiveBlocks >= BLOCK_ALERT_THRESHOLD && !state.blockAlertSent) {
      // Only mark as sent if it actually went out, so a transient EmailJS
      // outage does not permanently swallow the warning.
      state.blockAlertSent = await notifyBlocked(state.consecutiveBlocks, reason);
    } else if (state.blockAlertSent) {
      console.error('Failure alert already sent for this outage.');
    } else {
      const left = BLOCK_ALERT_THRESHOLD - state.consecutiveBlocks;
      console.error(`Will alert after ${left} more consecutive failure(s).`);
    }

    saveState(state);
    process.exit(2);
  }

  if (fetched.blocked) await blindRun(fetched.reason);

  const parsed = extractInitialState(fetched.html);
  if (!parsed) {
    await blindRun('window.__INITIAL_STATE__ not found - page layout may have changed');
  }

  const analysis = analyseState(parsed, watchDates.map(urlDate));
  if (!analysis.ok) await blindRun(analysis.reason);

  if (state.consecutiveBlocks > 0) console.log('\nRecovered - page readable again.');
  state.consecutiveBlocks = 0;
  state.blockAlertSent = false;

  console.log(`\nBooking window on sale: ${analysis.stripOnSale.join(', ') || '(none)'}`);
  console.log(`Strip covers:           ${analysis.stripRange.join(', ')}`);

  for (let i = 0; i < analysis.results.length; i++) {
    const r = analysis.results[i];
    const label = humanDate(watchDates[i]);
    console.log(`\n${label} [${r.dateCode}] -> ${r.note}`);

    if (r.onSale && !state.notified[r.dateCode]) {
      await notifyAvailable(
        `IMAX OPEN - The Odyssey, ${label}`,
        `IMAX tickets for The Odyssey are now on sale for ${label} (Chennai).\n\n` +
        `Book now: ${BASE_URL}/${r.dateCode}`
      );
      state.notified[r.dateCode] = new Date().toISOString();
    } else if (r.onSale) {
      console.log('   already notified - not re-sending');
    } else if (state.notified[r.dateCode]) {
      // Went off sale again; re-arm so a reopen alerts.
      console.log('   was on sale, no longer - re-arming');
      delete state.notified[r.dateCode];
    }
  }

  saveState(state);
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
