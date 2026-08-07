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
const DISTRICT_TOKEN = (process.env.DISTRICT_COOKIES || process.env.DISTRICT_ACCESS_TOKEN || '').trim();
const START_TIME     = (process.env.START_TIME || '').trim();
const END_TIME       = (process.env.END_TIME || '').trim();
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 3);
const CONSOLIDATE_ALERTS = process.env.CONSOLIDATE_ALERTS === 'true';

function parseConfigTime(tstr) {
  if (!tstr) return null;
  const m = tstr.match(/(\d+):(\d+)\s*(AM|PM)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  if (m[3]) {
    if (m[3].toUpperCase() === 'PM' && h < 12) h += 12;
    if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
  }
  return h * 60 + parseInt(m[2], 10);
}

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
  
  let weekdaysStr = WATCH_WEEKDAY;
  if (weekdaysStr === 'weekend') weekdaysStr = 'saturday, sunday';
  
  const requestedDays = weekdaysStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const dates = [];
  
  for (const dayStr of requestedDays) {
    const wi = WEEKDAY_NAMES.findIndex(n => n.startsWith(dayStr));
    if (wi !== -1) {
      dates.push(...nextWeekdays(wi, DATES_TO_CHECK));
    }
  }
  return dates.length ? [...new Set(dates)].sort() : nextWeekdays(5, DATES_TO_CHECK);
}

async function sendEmail(templateId, subject, message) {
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service_id: process.env.EMAILJS_SERVICE_ID, template_id: templateId, user_id: process.env.EMAILJS_PUBLIC_KEY, accessToken: process.env.EMAILJS_PRIVATE_KEY, template_params: { subject, message, to_email: process.env.TO_EMAIL } })
  });
  if (!res.ok) throw new Error('EmailJS ' + res.status + ': ' + await res.text());
}

async function sendTelegramAlert(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
    if (res.ok) console.log('   📱 Telegram alert sent to phone!');
  } catch (err) {
    console.error('   Telegram alert error:', err.message);
  }
}

async function sendWhatsAppAlert(message) {
  const phone = process.env.WHATSAPP_PHONE;
  const apiKey = process.env.WHATSAPP_API_KEY;
  if (!phone || !apiKey) return;
  try {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (res.ok) console.log('   💬 WhatsApp alert sent to phone!');
  } catch (err) {
    console.error('   WhatsApp alert error:', err.message);
  }
}

async function sendTwilioPhoneCall() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = process.env.TWILIO_FROM_PHONE;
  const toPhone = process.env.PHONE_NUMBER || process.env.WHATSAPP_PHONE;
  if (!accountSid || !authToken || !fromPhone || !toPhone) return;
  try {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const twiml = '<Response><Say voice="alice" loop="2">Alert! Your PVR movie tickets have been auto held! Check your WhatsApp and email for the payment link!</Say></Response>';
    const body = new URLSearchParams({
      To: toPhone,
      From: fromPhone,
      Twiml: twiml
    });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
    if (res.ok) console.log('   📞 Phone call alert triggered to your phone!');
  } catch (err) {
    console.error('   Twilio phone call error:', err.message);
  }
}

async function checkCookieHealth(browser) {
  const cookieStr = process.env.DISTRICT_COOKIES || process.env.DISTRICT_ACCESS_TOKEN || '';
  if (!cookieStr) return;
  try {
    const page = await browser.newPage();
    const cookiesToAdd = [];
    if (cookieStr.includes('=')) {
      for (const part of cookieStr.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k && v.length) {
          const name = k.trim();
          const value = v.join('=').trim();
          cookiesToAdd.push({ name, value, domain: '.district.in', path: '/' });
          cookiesToAdd.push({ name, value, domain: 'www.district.in', path: '/' });
        }
      }
    }
    await page.context().addCookies(cookiesToAdd);
    await page.goto('https://www.district.in/profile', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(2500);

    const currentUrl = page.url();
    const isExpired = currentUrl === 'https://www.district.in/' || currentUrl === 'https://www.district.in';

    if (isExpired) {
      console.log('\n⚠️ COOKIE EXPIRED ALERT: District session cookie has expired (redirected to homepage)!');
      const alertMsg = '⚠️ DISTRICT COOKIE EXPIRED: Your login session cookie on District has expired. Please copy a fresh cookie string from your browser and update DISTRICT_COOKIES in GitHub Secrets so auto-hold is 100% ready!';
      try { await sendEmail(process.env.EMAILJS_FAILURE_TEMPLATE_ID || process.env.EMAILJS_TEMPLATE_ID, '⚠️ DISTRICT COOKIE EXPIRED', alertMsg); } catch {}
      await sendTelegramAlert(alertMsg);
      await sendWhatsAppAlert(alertMsg);
      if (process.env.GITHUB_STEP_SUMMARY) {
        try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ⚠️ DISTRICT COOKIE EXPIRED\n\n${alertMsg}\n\n---\n`); } catch {}
      }
    } else {
      console.log('   [Cookie Health Check] District login session active & valid (on /profile)!');
    }
    await page.close().catch(() => {});
  } catch (err) {
    console.error('   [Cookie Health Error]', err.message);
  }
}

async function launchBrowser(profile) {
  const opts = { headless: true, args: launchArgs(profile), ...(PROXY_URL ? { proxy: { server: PROXY_URL } } : {}) };
  try { const b = await chromium.launch({ ...opts, channel: 'chrome' }); console.log('   Chrome ' + b.version()); return b; }
  catch  { const b = await chromium.launch(opts); console.log('   Chromium ' + b.version()); return b; }
}

async function holdSeats(browser, seatUrl, numTickets, preferredArea, token, guestToken, targetSeats = []) {
  const cookieStr = process.env.DISTRICT_COOKIES || process.env.DISTRICT_ACCESS_TOKEN || '';
  if (!cookieStr) return null;
  try {
    const context = await browser.newContext({
      userAgent: windowsUserAgent('131'),
      viewport: { width: 1920, height: 1080 },
      geolocation: { latitude: 11.9416, longitude: 79.8083 },
      permissions: ['geolocation']
    });

    const cookiesToAdd = [];
    if (cookieStr.includes('=')) {
      const parts = cookieStr.split(';');
      for (const part of parts) {
        const [k, ...v] = part.trim().split('=');
        if (k && v.length) {
          const name = k.trim();
          const value = v.join('=').trim();
          cookiesToAdd.push({ name, value, domain: '.district.in', path: '/' });
          cookiesToAdd.push({ name, value, domain: 'www.district.in', path: '/' });
        }
      }
    } else {
      cookiesToAdd.push({ name: 'x-access-token', value: cookieStr, domain: '.district.in', path: '/' });
      cookiesToAdd.push({ name: 'x-access-token', value: cookieStr, domain: 'www.district.in', path: '/' });
    }

    await context.addCookies(cookiesToAdd);

    const page = await context.newPage();
    console.log('   [Auto-Hold UI] Opening seat layout page as logged-in user...');
    await page.goto(seatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // STEP 1: Dismiss promotional modal if present
    const closeIcon = page.locator('[data-testid="close-icon"]');
    if (await closeIcon.isVisible().catch(() => false)) {
      console.log('   [Auto-Hold UI] Dismissing modal...');
      await closeIcon.click();
      await page.waitForTimeout(1000);
    }

    // STEP 2: Select ADJACENT available seats
    let seatsClicked = 0;
    if (targetSeats && targetSeats.length >= numTickets) {
      const label = targetSeats.map(s => `${s.phyRowId}${s.displaySeatNumber || s.seatNumber}`).join(', ');
      console.log(`   [Auto-Hold UI] Target adjacent seats: ${label}`);
      for (const s of targetSeats) {
        const num = s.displaySeatNumber || s.seatNumber;
        const seatLoc = page.locator(`span[aria-label*="available"][aria-label*="row ${s.phyRowId}"][aria-label*="${num}"]`).first();
        if (await seatLoc.isVisible().catch(() => false)) {
          await seatLoc.click();
          seatsClicked++;
          await page.waitForTimeout(400);
        }
      }
    }

    // Fallback if targetSeats locator didn't hit: strictly select side-by-side contiguous seats in the same row
    if (seatsClicked < numTickets) {
      console.log(`   [Auto-Hold UI] Searching for side-by-side contiguous seats in the same row...`);
      const clickedContiguous = await page.evaluate(({ numTickets, preferredArea }) => {
        const areaFilter = preferredArea ? preferredArea.toLowerCase() : '';
        const seats = [...document.querySelectorAll('span[aria-label*="available"][aria-label*="seat"]')].filter(el => {
          const label = (el.getAttribute('aria-label') || '').toLowerCase();
          if (label.includes('unavailable')) return false;
          if (areaFilter && !label.includes(areaFilter)) return false;
          return true;
        });

        const parsed = [];
        for (const el of seats) {
          const label = el.getAttribute('aria-label') || '';
          const rowMatch = label.match(/row\s+([A-Za-z0-9]+)/i);
          const seatMatch = label.match(/seat\s+(\d+)/i);
          if (rowMatch && seatMatch) {
            parsed.push({ el, row: rowMatch[1].toUpperCase(), num: parseInt(seatMatch[1], 10) });
          }
        }

        const byRow = {};
        for (const s of parsed) {
          if (!byRow[s.row]) byRow[s.row] = [];
          byRow[s.row].push(s);
        }

        for (const rowId of Object.keys(byRow)) {
          const rowSeats = byRow[rowId].sort((a, b) => a.num - b.num);
          if (rowSeats.length < numTickets) continue;
          for (let i = 0; i <= rowSeats.length - numTickets; i++) {
            const group = rowSeats.slice(i, i + numTickets);
            if (group.every((s, j) => j === 0 || s.num === group[j - 1].num + 1)) {
              for (const s of group) {
                s.el.click();
              }
              return { success: true, label: group.map(s => `${s.row}${s.num}`).join(', ') };
            }
          }
        }
        return { success: false };
      }, { numTickets, preferredArea });

      if (clickedContiguous.success) {
        console.log(`   [Auto-Hold UI] Successfully selected adjacent seats: ${clickedContiguous.label}`);
        seatsClicked = numTickets;
      } else {
        console.log(`   [Auto-Hold UI] No side-by-side adjacent seats available. Skipping hold to prevent split seating.`);
      }
    }

    if (seatsClicked >= numTickets) {
      await page.waitForTimeout(1500);

      // STEP 3: Click Proceed button
      const proceedBtn = page.locator('button, div[role="button"]').filter({ hasText: /^Proceed$/i }).first();
      if (await proceedBtn.isVisible().catch(() => false)) {
        console.log('   [Auto-Hold UI] Clicking Proceed button...');
        await proceedBtn.click();
        await page.waitForTimeout(4000);

        // STEP 4: Handle F&B Skip modal if present
        console.log('   [Auto-Hold UI] Skipping F&B modal...');
        const clickedSkip = await page.evaluate(() => {
          const all = [...document.querySelectorAll('*')];
          const skipEl = all.find(el => el.children.length === 0 && el.innerText && el.innerText.trim() === 'Skip');
          if (skipEl) { skipEl.click(); return true; }
          return false;
        });

        if (clickedSkip) {
          await page.waitForTimeout(4000);
        }

        const heldUrl = page.url();
        console.log('   [Auto-Hold UI] Success! Held Order URL: ' + heldUrl);
        await context.close();
        return heldUrl;
      }
    }
    await context.close();
    return null;
  } catch (e) {
    console.log('   [Auto-Hold UI] Error: ' + e.message);
    return null;
  }
}

function parseSessions(cinemaApiBody, date) {
  // Cinema API structure varies — try multiple known shapes
  if (!cinemaApiBody) return [];
  try {
    const data = JSON.parse(cinemaApiBody);
    const sessions = [];
    // Walk the whole response looking for objects with sessionId + showTime
    const walk = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 15) return;
      // A session object has sessionId/id and showTime/time
      if ((node.sessionId || node.id) && (node.showTime || node.sTime || node.time) && node.lang) {
        sessions.push({
          sessionId: String(node.sessionId || node.id),
          time:      node.showTime || node.sTime || node.time || '',
          language:  node.lang || node.language || '',
          frmtId:    node.frmtId || node.sessionId || node.id || '',
          contentId: node.contentId || '',
          movie:     node.movieName || node.name || '',
        });
        return;
      }
      for (const v of (Array.isArray(node) ? node : Object.values(node))) {
        walk(v, depth + 1);
      }
    };
    walk(data);
    return sessions;
  } catch { return []; }
}
function parseShows(text, date) {
  const shows = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const timeRe = /^(\d{1,2}:\d{2}\s*[AP]M)$/i;
  const langRe  = /^(Tamil|Hindi|English|Telugu|Malayalam|Kannada)$/i;
  // Match rating lines like: "A | Tamil", "UA13+ | Tamil, English", "UA13+", "A"
  const ratingRe = /^(UA\d*[+]?|[UAG])(\s*\||\s*$)/i;
  let currentMovie = '', currentLang = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Rating line detected → previous line is the movie title
    if (ratingRe.test(line) && i > 0) {
      currentMovie = lines[i - 1];
      // Language may be on the same line: "A | Tamil" or "UA13+ | Tamil, English"
      const inlineMatch = line.match(/\|\s*(Tamil|Hindi|English|Telugu|Malayalam|Kannada)/i);
      if (inlineMatch) currentLang = inlineMatch[1];
    }
    // Standalone language line
    if (langRe.test(line)) currentLang = line;
    // Time line → record a show
    if (timeRe.test(line) && currentMovie) {
      shows.push({ movie: currentMovie, language: currentLang || 'Tamil', time: line.trim(), date });
    }
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
    let cinemaApiBody = null;

    await ctx.route('**/*', async route => {
      try {
        const req = route.request();
        const resp = await route.fetch();
        let body = ''; try { body = await resp.text(); } catch {}
        if (req.url().includes('/gw/consumer/movies/v1/select-seat')) { seatApiBody = body; guestToken = req.headers()['x-guest-token'] || null; }
        if (req.url().includes('/gw/consumer/movies/v3/cinema')) cinemaApiBody = body;
        await route.fulfill({ response: resp, body });
      } catch { /* request context disposed during navigation — safe to ignore */ }
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

      const showBlocks = await page.evaluate(() => {
        const lis = [...document.querySelectorAll('li[class*="timeblock"][role="button"]')];
        return lis.map((li, idx) => {
          const anchor = li.querySelector('a');
          const timeDiv = li.querySelector('[class*="__time"]');
          const timeText = (timeDiv ? timeDiv.firstChild?.textContent?.trim() : '') || li.textContent?.trim().substring(0,8);
          const noTicket = li.textContent?.includes('No tickets');
          
          let parentMovieDiv = li.closest('li[class*="__movieSessions"]') || li.closest('div[class*="movie-card"]');
          if (!parentMovieDiv) {
            let p = li.parentElement;
            while(p && p.tagName !== 'BODY') {
              if (p.className && typeof p.className === 'string' && (p.className.includes('movieSessions') || p.className.includes('movie-card'))) {
                parentMovieDiv = p; break;
              }
              p = p.parentElement;
            }
          }
          
          let movieTitle = '';
          let movieLang = '';
          if (parentMovieDiv) {
            const titleEl = parentMovieDiv.querySelector('[class*="movieDetailsDivHeading"], h3, h2, h4');
            if (titleEl) movieTitle = titleEl.innerText?.trim();
            else {
              const textLines = parentMovieDiv.innerText.split('\n').map(l => l.trim()).filter(Boolean);
              if (textLines.length > 0) movieTitle = textLines[0];
            }

            let curr = li;
            while (curr && curr !== parentMovieDiv) {
              let prev = curr.previousElementSibling;
              while (prev) {
                if (prev.className && typeof prev.className === 'string' && prev.className.includes('languageLabelHeading')) {
                  movieLang = prev.innerText?.trim();
                  break;
                }
                const subLang = prev.querySelector ? prev.querySelector('[class*="languageLabelHeading"]') : null;
                if (subLang) {
                  movieLang = subLang.innerText?.trim();
                  break;
                }
                prev = prev.previousElementSibling;
              }
              if (movieLang) break;
              curr = curr.parentElement;
            }
            if (!movieLang) movieLang = parentMovieDiv.innerText;
          }

          return { idx, timeText: (timeText||'').trim().substring(0,10), noTicket, directHref: anchor?.href || '', movieTitle, movieLang };
        }).filter(s => /\d{1,2}:\d{2}/.test(s.timeText || ''));
      });

      console.log('   show blocks on page: ' + showBlocks.length);
      
      const startMin = parseConfigTime(START_TIME);
      const endMin = parseConfigTime(END_TIME);
      
      const validShows = showBlocks.filter(s => {
        if (s.noTicket) return false;
        if (TARGET_MOVIE) {
          const reqMovies = TARGET_MOVIE.split(',').map(m => m.trim().toLowerCase()).filter(Boolean);
          if (!reqMovies.some(m => s.movieTitle.toLowerCase().includes(m))) return false;
        }
        if (WATCH_LANGUAGE) {
          const reqLangs = WATCH_LANGUAGE.split(',').map(l => l.trim().toLowerCase()).filter(Boolean);
          if (!reqLangs.some(l => s.movieLang.toLowerCase().includes(l))) return false;
        }
        if (startMin !== null || endMin !== null) {
          const showMin = parseConfigTime(s.timeText);
          if (showMin !== null) {
             if (startMin !== null && showMin < startMin) return false;
             if (endMin !== null && showMin > endMin) return false;
          }
        }
        return true;
      });

      if (TARGET_MOVIE) {
        const reqMovies = TARGET_MOVIE.split(',').map(m => m.trim().toLowerCase()).filter(Boolean);
        validShows.sort((a, b) => {
          const indexA = reqMovies.findIndex(m => a.movieTitle.toLowerCase().includes(m));
          const indexB = reqMovies.findIndex(m => b.movieTitle.toLowerCase().includes(m));
          return (indexA === -1 ? 99 : indexA) - (indexB === -1 ? 99 : indexB);
        });
      }

      console.log('   valid matching shows: ' + validShows.length);
      if (validShows.length === 0) { await checkCookieHealth(browser); await browser.close(); return { ok: true, shows: [], date }; }

      const results = [];
      
      for (let i = 0; i < validShows.length; i += MAX_CONCURRENCY) {
        const batch = validShows.slice(i, i + MAX_CONCURRENCY);
        const batchPromises = batch.map(async (block, bIdx) => {
          const globalIdx = i + bIdx + 1;
          const seatPage = await ctx.newPage();
          
          let seatApiBody = null, guestToken = null;
          await seatPage.route('**/*', async route => {
            try {
              const req = route.request();
              const resp = await route.fetch();
              let body = ''; try { body = await resp.text(); } catch {}
              if (req.url().includes('/gw/consumer/movies/v1/select-seat')) { seatApiBody = body; guestToken = req.headers()['x-guest-token'] || null; }
              await route.fulfill({ response: resp, body });
            } catch { }
          });
          
          try {
            await seatPage.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await seatPage.waitForTimeout(rand(1000, 2000));
            await seatPage.evaluate(idx => {
              const lis = [...document.querySelectorAll('li[class*="timeblock"][role="button"]')];
              if (lis[idx]) lis[idx].click();
            }, block.idx);
            
            try { await seatPage.waitForURL('**/seat-layout/**', { timeout: 8000 }); } catch {}
            await seatPage.waitForTimeout(rand(3000, 5000));
            const seatUrl = seatPage.url();
            
            let resultObj = null;
            if (!seatApiBody) { console.log('   [' + globalIdx + '] ' + block.timeText + ' select-seat not captured'); }
            else {
              const sd = parseSeatApiBody(seatApiBody);
              if (sd) {
                const analysis = analyseSeatLayout(sd, NUM_TICKETS, PREFERRED_AREA||null);
                if (analysis.ok) {
                  const pa = analysis.areas.find(a => !PREFERRED_AREA || a.areaCode === PREFERRED_AREA);
                  console.log('   [' + globalIdx + '] ' + block.timeText + ' - ' + (pa ? pa.available : 0) + ' free seats in ' + (PREFERRED_AREA||'any'));
                  resultObj = { show: { movie: block.movieTitle, language: block.movieLang, time: block.timeText, date }, seatUrl, analysis, hasEnough: pa ? pa.available >= MIN_SEATS : false, guestToken, tempTransId: analysis.tempTransId, product_id: analysis.product_id };
                }
              }
            }
            await seatPage.close();
            return resultObj;
          } catch (e) {
            console.log('   [' + globalIdx + '] ' + block.timeText + ' error: ' + e.message);
            await seatPage.close().catch(()=>{});
            return null;
          }
        });
        
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults.filter(Boolean));
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
  let activeHoldDone = false;
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
    if (state.consecutiveBlocks > 0) console.log('\\nRecovered - page readable again.');
    state.consecutiveBlocks = 0; state.blockAlertSent = false;
    let digestShows = [];
    
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
      if (DISTRICT_TOKEN && !activeHoldDone) {
        console.log('\n[Auto-Hold UI] Attempting Playwright UI seat reservation for ' + show.time + '...');
        const holdProfile = buildProfile(FINGERPRINT_SEED + '#hold#' + show.time);
        const hb = await launchBrowser(holdProfile);
        paymentUrl = await holdSeats(hb, seatUrl, NUM_TICKETS, PREFERRED_AREA, DISTRICT_TOKEN, guestToken, sg?.seats || []);
        await hb.close().catch(() => {});
        if (paymentUrl) {
          console.log('   payment URL: ' + paymentUrl);
          activeHoldDone = true;
        } else console.log('   auto-hold failed - notify-only email');
      } else if (DISTRICT_TOKEN && activeHoldDone) {
        console.log('   (Skipping auto-hold for ' + show.time + ' to protect existing active transaction)');
      }
      
      state.notified[key] = new Date().toISOString();
      const subject = 'SEATS OPEN: ' + show.movie + ' | ' + show.language + ' | ' + show.time + ' - PVR Pondy';
      let body = show.movie + ' (' + show.language + ')\n' + dateLabel + ' | ' + show.time + '\nPVR Providence Mall, Pondicherry\n\n';
      body += 'Availability:\n' + areaLines + suggestLine + '\n\n';
      if (paymentUrl) body += 'Seats auto-selected!\nPAY NOW: ' + paymentUrl + '\n(Link valid ~5 minutes)\n\n';
      else body += 'Book now: ' + seatUrl + '\n\n';
      body += 'Checked: ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      
      if (CONSOLIDATE_ALERTS) {
        digestShows.push({ subject, body, time: show.time });
      } else {
        console.log('\nALERT: seats available for ' + show.time + ' - emailing');
        try { await sendEmail(process.env.EMAILJS_TEMPLATE_ID, subject, body); console.log('   email sent'); }
        catch (e) { console.error('   email error:', e.message); }
        await sendTelegramAlert(`🚨 ${subject}\n\n${body}`);
        await sendWhatsAppAlert(`🚨 ${subject}\n\n${body}`);
        await sendTwilioPhoneCall();
        if (process.env.GITHUB_STEP_SUMMARY) {
          try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 🚨 ${subject}\n\n${body}\n\n---\n`); } catch {}
        }
      }
    }
    
    if (CONSOLIDATE_ALERTS && digestShows.length > 0) {
       console.log('\nALERT: sending consolidated email for ' + digestShows.length + ' shows');
       const digestSubject = 'SEATS OPEN: ' + digestShows.length + ' shows for ' + TARGET_MOVIE + ' - PVR Pondy';
       const digestBody = digestShows.map(d => d.body).join('\n-----------------------------------\n\n');
       try { await sendEmail(process.env.EMAILJS_TEMPLATE_ID, digestSubject, digestBody); console.log('   email sent'); }
       catch (e) { console.error('   email error:', e.message); }
       await sendTelegramAlert(`🚨 ${digestSubject}\n\n${digestBody}`);
       await sendWhatsAppAlert(`🚨 ${digestSubject}\n\n${digestBody}`);
       await sendTwilioPhoneCall();
       if (process.env.GITHUB_STEP_SUMMARY) {
         try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 🚨 ${digestSubject}\n\n${digestBody}\n\n---\n`); } catch {}
       }
    }
  }
  saveState(state);
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
