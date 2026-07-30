import { chromium } from 'playwright';
import fs from 'fs';
import { windowsUserAgent, launchArgs, contextOptions, stealthInitScript, probeClientHints, fixAcceptLanguage, actHuman, rand } from './stealth.js';
import { buildProfile, describeProfile } from './fingerprint.js';
import { analyseSeatLayout, parseSeatApiBody } from './extract.js';

// CONFIG
const CINEMA_URL = (process.env.CINEMA_URL_BASE || 'https://www.district.in/movies/pvr-providence-mall-providence-mall-pondicherry-in-puducherry-CD1025204').replace(/\/+$/, '');
const TARGET_MOVIE   = (process.env.TARGET_MOVIE   || '').trim();
const WATCH_LANGUAGE = (process.env.WATCH_LANGUAGE || '').trim().toLowerCase();
const WATCH_DATES    = (process.env.WATCH_DATES    || '').trim();
const WATCH_WEEKDAY  = (process.env.WATCH_WEEKDAY  || 'friday').trim().toLowerCase();
const DATES_TO_CHECK = Number(process.env.DATES_TO_CHECK || 1);
const NUM_TICKETS    = Number(process.env.NUM_TICKETS    || 2);
const PREFERRED_AREA = (process.env.PREFERRED_AREA || 'EL').trim().toUpperCase();
const MIN_SEATS      = Number(process.env.MIN_SEATS      || NUM_TICKETS);
const STOP           = (process.env.STOP || '').trim();
const PROXY_URL      = process.env.PROXY_URL || '';
const MAX_ATTEMPTS   = Number(process.env.MAX_ATTEMPTS || 3);
const BLOCK_THRESHOLD = Number(process.env.BLOCK_ALERT_THRESHOLD || 3);
const STATE_FILE     = 'state.json';
const DISTRICT_TOKEN = (process.env.DISTRICT_ACCESS_TOKEN || '').trim();

const FINGERPRINT_SEED = process.env.FINGERPRINT_SEED || (process.env.GITHUB_RUN_ID ? process.env.GITHUB_RUN_ID + '-' + (process.env.GITHUB_RUN_ATTEMPT||1) : null) || Date.now() + '-' + Math.random().toString(36).slice(2);
const WEEKDAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const BLOCK_SIGNALS = [/sorry, you have been blocked/i,/attention required/i,/access denied/i,/just a moment/i,/checking your browser/i,/captcha/i,/cloudflare ray id/i,/unusual traffic/i];

function loadState() {
  try { const p = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); return { notified: p.notified || {}, consecutiveBlocks: p.consecutiveBlocks || 0, blockAlertSent: p.blockAlertSent || false, lastRun: p.lastRun || null }; }
  catch { return { notified: {}, consecutiveBlocks: 0, blockAlertSent: false, lastRun: null }; }
}
function saveState(s) { s.lastRun = new Date().toISOString(); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n'); }

function todayIST() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }

function nextWeekdays(weekday, count) {
  const [y, m, d] = todayIST().split('-').map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  const out = [];
  while (out.length < count) { if (cursor.getUTCDay() === weekday) out.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  return out;
}

function getWatchDates() {
  if (WATCH_DATES) return WATCH_DATES.split(',').map(s => s.trim()).filter(Boolean);
  const wi = WEEKDAY_NAMES.findIndex(n => n.startsWith(WATCH_WEEKDAY));
  return nextWeekdays(wi === -1 ? 5 : wi, DATES_TO_CHECK);
}

async function sendEmail(templateId, subject, message) {
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service_id: process.env.EMAILJS_SERVICE_ID, template_id: templateId, user_id: process.env.EMAILJS_PUBLIC_KEY, accessToken: process.env.EMAILJS_PRIVATE_KEY, template_params: { subject, message, to_email: process.env.TO_EMAIL } })
  });
  if (!res.ok) throw new Error('EmailJS ' + res.status + ': ' + await res.text());
}

async function launchBrowser(profile) {
  const opts = { headless: true, args: launchArgs(profile), ...(PROXY_URL ? { proxy: { server: PROXY_URL } } : {}) };
  try { const b = await chromium.launch({ ...opts, channel: 'chrome' }); console.log('   Chrome ' + b.version()); return b; }
  catch  { const b = await chromium.launch(opts); console.log('   Chromium ' + b.version()); return b; }
}

async function holdSeats(page, tempTransId, product_id, seats, guestToken) {
  if (!DISTRICT_TOKEN) return null;
  try {
    const result = await page.evaluate(async ({ transId, pid, seats, token, guest }) => {
      const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*', 'x-app-type': 'ed_web', 'x-client-id': 'district-web', 'x-app-version': '11.11.1', 'x-access-token': token };
      if (guest) headers['x-guest-token'] = guest;
      const res = await fetch('https://www.district.in/gw/consumer/movies/v1/checkout?version=3&site_id=1&channel=web&child_site_id=1&platform=district',
        { method: 'POST', headers, credentials: 'include', body: JSON.stringify({ tempTransId: transId, product_id: pid, seats }) });
      return { status: res.status, body: await res.text() };
    }, { transId: tempTransId, pid: product_id, seats, token: DISTRICT_TOKEN, guest: guestToken });
    if (result.status === 200) {
      const data = JSON.parse(result.body);
      return data.paymentUrl || data.redirectUrl || data.checkout_url || data.url || null;
    }
    console.log('   checkout HTTP ' + result.status + ' - ' + result.body.substring(0, 120));
  } catch (e) { console.log('   checkout error: ' + e.message); }
  return null;
}

function parseShows(text, date) {
  const shows = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const timeRe = /^(\d{1,2}:\d{2}\s*[AP]M)$/i;
  const langRe  = /^(Tamil|Hindi|English|Telugu|Malayalam|Kannada)$/i;
  let currentMovie = '', currentLang = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(UA\d*\+?|^U$|^A$|Adult|UA13|UA16)\s*\|/i.test(line) && i > 0) currentMovie = lines[i - 1];
    if (langRe.test(line)) currentLang = line;
    if (timeRe.test(line) && currentMovie) shows.push({ movie: currentMovie, language: currentLang || 'Tamil', time: line.trim(), date });
  }
  return shows;
}

async function checkDate(date) {
  const listingUrl = CINEMA_URL + '?fromdate=' + date;
  console.log('\n── ' + date + ' -> ' + listingUrl);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const profile = buildProfile(FINGERPRINT_SEED + '#' + attempt + '#' + date);
    console.log('\n   attempt ' + attempt + '/' + MAX_ATTEMPTS + ' - ' + describeProfile(profile));
    const browser = await launchBrowser(profile);
    profile.chromeVersion = browser.version();
    const ua = windowsUserAgent(profile.chromeVersion);
    profile.uaBrands = await probeClientHints(browser);
    const ctx = await browser.newContext({ ...contextOptions(profile, ua), geolocation: { latitude: 11.9416, longitude: 79.8083 }, permissions: ['geolocation'] });
    await fixAcceptLanguage(ctx, profile);
    await ctx.addInitScript(stealthInitScript, profile);
    let seatApiBody = null, guestToken = null;
    await ctx.route('**/*', async route => {
      const req = route.request();
      const resp = await route.fetch();
      let body = ''; try { body = await resp.text(); } catch {}
      if (req.url().includes('/gw/consumer/movies/v1/select-seat')) { seatApiBody = body; guestToken = req.headers()['x-guest-token'] || null; }
      await route.fulfill({ response: resp, body });
    });
    const page = await ctx.newPage();
    try {
      const res = await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const status = res?.status() ?? 0;
      await page.waitForTimeout(rand(2000, 3500));
      await actHuman(page, profile);
      const html = await page.content();
      const blocked = status === 403 || status === 429 || status === 503 || BLOCK_SIGNALS.some(re => re.test(html.slice(0, 8000)));
      if (blocked) {
        console.log('   blocked HTTP ' + status);
        await browser.close();
        if (attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, rand(8000, 20000) * attempt)); continue; }
        return { ok: false, reason: 'blocked HTTP ' + status };
      }
      console.log('   listing loaded (' + status + ', ' + html.length + ' B)');
      const seatLinks = await page.evaluate(() => [...document.querySelectorAll('a[href*="seat-layout"]')].map(a => a.href));
      const pageText = await page.innerText('body').catch(() => '');
      console.log('   seat-layout links: ' + seatLinks.length);
      const shows = parseShows(pageText, date);
      console.log('   parsed shows: ' + shows.length);
      const matching = shows.filter(s => {
        const mMatch = !TARGET_MOVIE   || s.movie.toLowerCase().includes(TARGET_MOVIE.toLowerCase());
        const lMatch  = !WATCH_LANGUAGE || s.language.toLowerCase().includes(WATCH_LANGUAGE);
        return mMatch && lMatch;
      });
      console.log('   matching (movie="' + TARGET_MOVIE + '" lang="' + WATCH_LANGUAGE + '"): ' + matching.length);
      if (matching.length === 0 && seatLinks.length === 0) { await browser.close(); return { ok: true, shows: [], date }; }
      const results = [];
      const linksToCheck = seatLinks.slice(0, Math.max(matching.length, seatLinks.length));
      for (let li = 0; li < linksToCheck.length; li++) {
        const seatUrl = linksToCheck[li];
        const show = matching[li] || matching[0] || { movie: TARGET_MOVIE, language: WATCH_LANGUAGE, time: '?', date };
        seatApiBody = null;
        console.log('\n   [' + (li+1) + '/' + linksToCheck.length + '] ' + show.movie + ' | ' + show.language + ' | ' + show.time);
        try { await page.goto(seatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(rand(3000, 5000)); }
        catch (e) { console.log('   seat page error: ' + e.message); continue; }
        if (!seatApiBody) { console.log('   select-seat API not captured'); continue; }
        const seatData = parseSeatApiBody(seatApiBody);
        if (!seatData) { console.log('   could not parse seat data'); continue; }
        const analysis = analyseSeatLayout(seatData, NUM_TICKETS, PREFERRED_AREA || null);
        if (!analysis.ok) { console.log('   analysis error: ' + analysis.reason); continue; }
        for (const area of analysis.areas) console.log('   ' + area.areaCode + ' Rs.' + area.areaPrice + ': ' + area.available + ' free / ' + area.total + ' total');
        const prefArea = analysis.areas.find(a => !PREFERRED_AREA || a.areaCode === PREFERRED_AREA);
        const hasEnough = prefArea ? prefArea.available >= MIN_SEATS : false;
        results.push({ show, seatUrl, analysis, hasEnough, guestToken, tempTransId: analysis.tempTransId, product_id: analysis.product_id });
        if (li < linksToCheck.length - 1) { await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(rand(1500, 2500)); }
      }
      await browser.close();
      return { ok: true, shows: results, date };
    } catch (e) {
      console.log('   error: ' + e.message);
      await browser.close().catch(() => {});
      if (attempt === MAX_ATTEMPTS) return { ok: false, reason: 'error: ' + e.message };
      await new Promise(r => setTimeout(r, rand(5000, 12000) * attempt));
    }
  }
  return { ok: false, reason: 'exhausted all attempts' };
}

async function main() {
  if (STOP) { console.log('STOPPED (STOP=' + STOP + '). Delete the variable to resume.'); return; }
  if (!TARGET_MOVIE) { console.error('Set TARGET_MOVIE env variable (e.g. "Jana Nayagan")'); process.exit(1); }
  const state = loadState();
  const watchDates = getWatchDates();
  console.log('Today     : ' + todayIST());
  console.log('Watching  : ' + watchDates.join(', '));
  console.log('Movie     : ' + TARGET_MOVIE);
  console.log('Language  : ' + (WATCH_LANGUAGE || 'any'));
  console.log('Tickets   : ' + NUM_TICKETS + ' | Category: ' + (PREFERRED_AREA || 'any'));
  console.log('Auto-book : ' + (DISTRICT_TOKEN ? 'YES (token set)' : 'NO - notify only'));
  for (const date of watchDates) {
    const result = await checkDate(date);
    if (!result.ok) {
      state.consecutiveBlocks++;
      console.error('\nCOULD NOT READ PAGE - ' + result.reason);
      if (state.consecutiveBlocks >= BLOCK_THRESHOLD && !state.blockAlertSent) {
        try {
          await sendEmail(process.env.EMAILJS_FAILURE_TEMPLATE_ID, 'PVR checker blocked (' + state.consecutiveBlocks + ' runs)', 'Checker failed ' + state.consecutiveBlocks + ' times.\nReason: ' + result.reason + '\n\nCheck manually: ' + CINEMA_URL);
          state.blockAlertSent = true;
        } catch (e) { console.error('failure email error:', e.message); }
      }
      saveState(state); process.exit(2);
    }
    if (state.consecutiveBlocks > 0) console.log('\nRecovered - page readable again.');
    state.consecutiveBlocks = 0; state.blockAlertSent = false;
    for (const r of result.shows) {
      const { show, seatUrl, analysis, hasEnough, guestToken, tempTransId, product_id } = r;
      const key = date + '|' + show.movie + '|' + show.language + '|' + show.time;
      if (!hasEnough) {
        if (state.notified[key]) { delete state.notified[key]; console.log(show.time + ' - was notified, re-arming'); }
        else console.log(show.time + ' - not enough seats (need ' + MIN_SEATS + ')');
        continue;
      }
      if (state.notified[key]) { console.log(show.time + ' - already notified'); continue; }
      const dateLabel = new Date(date + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const areaLines = analysis.areas.map(a => '  ' + (a.areaDesc||a.areaCode) + ' (Rs.' + a.areaPrice + '): ' + a.available + ' seats free / ' + a.total + ' total').join('\n');
      const sg = analysis.suggestion;
      const suggestLine = sg ? '\nBest ' + NUM_TICKETS + ' seats: ' + sg.label + (sg.hasBest ? ' (Best Seats)' : '') + ' - Rs.' + sg.total : '';
      let paymentUrl = null;
      if (DISTRICT_TOKEN && sg) {
        console.log('\nAuto-hold: ' + sg.label + '...');
        const hb = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
        const hc = await hb.newContext({ userAgent: windowsUserAgent('131') });
        const hp = await hc.newPage();
        await hp.goto(seatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await hp.waitForTimeout(3000);
        const seatPayload = sg.seats.map(s => ({ areaNum: s.areaNum, areaCode: s.areaCode, gridRowId: s.gridRowId, gridSeatNum: s.gridSeatNum, seatNumber: s.seatNumber }));
        paymentUrl = await holdSeats(hp, tempTransId, product_id, seatPayload, guestToken);
        await hb.close();
        if (paymentUrl) console.log('   payment URL obtained!');
        else console.log('   auto-hold failed - notify-only email');
      }
      const subject = 'SEATS OPEN: ' + show.movie + ' | ' + show.language + ' | ' + show.time + ' - PVR Pondy';
      let body = show.movie + ' (' + show.language + ')\n' + dateLabel + ' | ' + show.time + '\nPVR Providence Mall, Pondicherry\n\n';
      body += 'Availability:\n' + areaLines + suggestLine + '\n\n';
      if (paymentUrl) body += 'Seats auto-selected!\nPAY NOW: ' + paymentUrl + '\n(Link valid ~5 minutes)\n\n';
      else body += 'Book now: ' + seatUrl + '\n\n';
      body += 'Checked: ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      console.log('\nALERT: seats available for ' + show.time + ' - emailing');
      try { await sendEmail(process.env.EMAILJS_TEMPLATE_ID, subject, body); state.notified[key] = new Date().toISOString(); console.log('   email sent'); }
      catch (e) { console.error('   email error:', e.message); }
    }
  }
  saveState(state);
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
