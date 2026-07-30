// Reads per-date IMAX availability from BookMyShow's server-rendered state.
//
// Two things here are non-obvious and were established by testing the live site:
//
// 1. Not the DOM. The client-side call to
//    /api/movies-data/v5/showtimes-by-event/primary-dynamic is 403'd for
//    automated clients, so the rendered page shows "Oops! Something went wrong"
//    with no showtimes. The same payload ships inside the HTML as
//    window.__INITIAL_STATE__, which is not behind that rule.
//
// 2. The date strip, not the showtime list. The embedded showtime list is
//    always TODAY's schedule whatever date the URL asks for (verified
//    byte-identical for dates months out). The date strip is genuinely
//    per-date. Also note the "IMAX 2D" chip's isDisabled flag means "IMAX is
//    the selected format", not "unavailable" - it is not an availability signal.

export function extractInitialState(html) {
  const marker = 'window.__INITIAL_STATE__';
  const at = html.indexOf(marker);
  if (at === -1) return null;

  const eq = html.indexOf('=', at + marker.length);
  if (eq === -1) return null;

  const stop = html.indexOf('</script>', eq);
  if (stop === -1) return null;

  try {
    return JSON.parse(html.slice(eq + 1, stop).trim().replace(/;+\s*$/, ''));
  } catch {
    return null;
  }
}

function* walk(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return;
  yield node;
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    yield* walk(value, depth + 1);
  }
}

const DATE_ID = /^\d{8}$/;

/**
 * Collect the date strip keyed by YYYYMMDD.
 *
 * Matched on shape rather than widget path so a layout change moves the strip
 * without breaking us. A date is on sale when it has a dateSelector cta and no
 * "disabled" styling; BookMyShow renders unavailable dates without a cta.
 */
function readDateStrip(payload) {
  const dates = new Map();

  for (const node of walk(payload)) {
    if (typeof node.id !== 'string' || !DATE_ID.test(node.id)) continue;

    const styleId = typeof node.styleId === 'string' ? node.styleId : '';
    if (!/^date-/.test(styleId) && node.cta?.type !== 'dateSelector') continue;

    const hasCta = node.cta?.type === 'dateSelector';
    const disabled = /disabled/i.test(styleId) ||
      (Array.isArray(node.data) &&
       node.data.some((d) => /disabled/i.test(d?.styleId ?? '')));

    if (!dates.has(node.id)) {
      dates.set(node.id, { dateCode: node.id, onSale: hasCta && !disabled });
    }
  }

  return dates;
}

/**
 * @param state    parsed window.__INITIAL_STATE__
 * @param dateStrs "YYYYMMDD" dates to report on
 */
export function analyseState(state, dateStrs) {
  const queries = state?.showtimesFunctionalApi?.queries ?? {};
  const key = Object.keys(queries).find((k) => k.includes('fetchPrimaryDynamic'));
  if (!key) return { ok: false, reason: 'no showtimes query in page state' };

  const payload = queries[key]?.data?.data;
  if (!payload) return { ok: false, reason: 'showtimes query has no payload' };

  const strip = readDateStrip(payload);
  if (strip.size === 0) {
    return { ok: false, reason: 'could not find the date strip in page state' };
  }

  const results = dateStrs.map((dateCode) => {
    const cell = strip.get(dateCode);
    if (!cell) {
      // Past the window BookMyShow currently publishes (~7 days).
      return { dateCode, onSale: false, note: 'not in booking window yet' };
    }
    return {
      dateCode,
      onSale: cell.onSale,
      note: cell.onSale ? 'ON SALE' : 'listed but not on sale'
    };
  });

  return {
    ok: true,
    stripRange: [...strip.keys()].sort(),
    stripOnSale: [...strip.values()].filter((c) => c.onSale).map((c) => c.dateCode),
    results
  };
}
