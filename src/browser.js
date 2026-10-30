// Playwright side: page outline for the LLM, and the before/after verifier.
// Always a fresh, logged-out context. No clicks, no form fills, no consent accepting.
const { chromium } = require('playwright');

const VIEWPORT = { width: 1280, height: 900 };
const SETTLE_MS = Number(process.env.SITEPATCH_SETTLE_MS || 2500);

let browserPromise;
function browser() {
  return (browserPromise ||= chromium.launch({ headless: true }));
}
async function closeBrowser() {
  if (browserPromise) (await browserPromise).close();
  browserPromise = undefined;
}

async function openPage(url, initScript) {
  const ctx = await (await browser()).newContext({ viewport: VIEWPORT, locale: 'en-US', timezoneId: 'UTC' });
  const page = await ctx.newPage();
  if (initScript) await page.addInitScript({ content: initScript });
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
  const blocked = await detectBlock(page, resp);
  return { ctx, page, status: resp ? resp.status() : 0, blocked };
}

// We never solve CAPTCHAs or click through walls: if we hit one, the site is out of scope.
async function detectBlock(page, resp) {
  const status = resp ? resp.status() : 0;
  const text = (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 3000) : '').catch(() => '')).toLowerCase();
  if (/captcha|verify you are human|are you a robot|unusual traffic|access denied|just a moment/.test(text)) return 'bot-check';
  if (!text.trim()) return 'empty-page';
  if (status === 403 || status === 429 || status >= 500) return `http-${status}`;
  return null;
}

// Compact, selector-oriented outline of the visible DOM. Ids, stable-looking classes,
// roles, aria-labels, data-testids and headings: what a selector author needs.
function outlineInPage(maxLines) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'LINK', 'META', 'TEMPLATE', 'IFRAME', 'BR', 'IMG', 'INPUT', 'OPTION']);
  const lines = [];
  const hashed = c => /[0-9a-f]{5,}|^css-|^sc-|__[a-zA-Z0-9]{5}$|^_[a-z0-9]{5,}$/i.test(c);
  function label(el) {
    let s = el.tagName.toLowerCase();
    if (el.id && !/\d{4,}/.test(el.id)) s += '#' + el.id;
    const cls = [...el.classList].filter(c => !hashed(c)).slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    for (const a of ['role', 'aria-label', 'data-testid', 'data-test-id', 'data-section', 'itemprop']) {
      const v = el.getAttribute(a);
      if (v) s += `[${a}="${v.slice(0, 40)}"]`;
    }
    return s;
  }
  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    t = t.replace(/\s+/g, ' ').trim();
    if (!t && /^H[1-6]$/.test(el.tagName)) t = el.innerText.replace(/\s+/g, ' ').trim();
    return t.slice(0, 50);
  }
  function walk(el, depth) {
    if (lines.length >= maxLines || SKIP.has(el.tagName.toUpperCase())) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) {
      if (getComputedStyle(el).display === 'none') return;
    }
    const interesting = el.id || el.classList.length || el.getAttribute('role') || el.getAttribute('aria-label') ||
      /^(H[1-6]|NAV|ASIDE|HEADER|FOOTER|MAIN|SECTION|ARTICLE|FORM|TABLE|UL|OL)$/.test(el.tagName);
    let next = depth;
    if (interesting && r.height >= 2) {
      const t = ownText(el);
      lines.push('  '.repeat(Math.min(depth, 12)) + label(el) + ` (y=${Math.round(r.top + scrollY)} h=${Math.round(r.height)})` + (t ? ` "${t}"` : ''));
      next = depth + 1;
    }
    // Repeated siblings (feed items, table rows) are collapsed per tag+class signature:
    // first 3 and the last one of each kind. Structurally unique children are always kept,
    // because that's where sidebars, TOCs and footers live.
    const kids = [...el.children].filter(k => !SKIP.has(k.tagName.toUpperCase()));
    const sig = k => k.tagName + '.' + k.className;
    const total = {}, seen = {};
    kids.forEach(k => (total[sig(k)] = (total[sig(k)] || 0) + 1));
    for (const k of kids) {
      const key = sig(k), n = (seen[key] = (seen[key] || 0) + 1);
      if (total[key] > 5 && n > 3 && n < total[key]) {
        if (n === 4) lines.push('  '.repeat(Math.min(next, 12)) + `... (${total[key] - 4} more ${k.tagName.toLowerCase()}${k.classList.length ? '.' + [...k.classList].slice(0, 2).join('.') : ''})`);
        continue;
      }
      walk(k, next);
    }
  }
  if (!document.body) return '';
  walk(document.body, 0);
  return lines.join('\n');
}

async function outline(url, maxLines = 400) {
  const { ctx, page, blocked, status } = await openPage(url);
  try {
    const title = await page.title();
    const text = await page.evaluate(outlineInPage, maxLines);
    return { title, outline: text, blocked, status };
  } finally {
    await ctx.close();
  }
}

// In-page measurement of what a spec targets. Used before and after the patch.
function measureInPage(spec) {
  const vis = el => el.checkVisibility ? el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true }) && el.getBoundingClientRect().height > 0
    : el.offsetParent !== null;
  const all = s => { try { return [...document.querySelectorAll(s)]; } catch (e) { return null; } };
  const de = document.documentElement, body = document.body || de;
  const docW = Math.max(de.scrollWidth, body.scrollWidth, innerWidth), docH = Math.max(de.scrollHeight, body.scrollHeight, innerHeight);
  const docArea = docW * docH;
  // Area of a set of elements, counting only outermost ones (nested matches would double count)
  // and clipping each rect to the document.
  const areaOf = els => els.filter(e => !els.some(o => o !== e && o.contains(e))).reduce((a, e) => {
    const r = e.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, docW) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom + scrollY, docH) - Math.max(r.top + scrollY, 0));
    return a + w * h;
  }, 0);
  const hide = spec.hide.map(s => {
    const els = all(s);
    if (!els) return { selector: s, invalid: true, matched: 0, visible: 0, area: 0 };
    const v = els.filter(vis);
    const area = areaOf(v.slice(0, 400));
    const first = v[0] && v[0].getBoundingClientRect().top + scrollY;
    return { selector: s, matched: els.length, visible: v.length, areaFrac: area / docArea, firstY: first };
  });
  const move = spec.move.map(m => {
    const ref = m.before || m.after;
    const a = all(m.selector), b = all(ref);
    const el = a && a[0], r = b && b[0];
    if (!el || !r) return { selector: m.selector, ref, found: !!el, refFound: !!r, inPlace: false };
    const pos = el.compareDocumentPosition(r);
    const elBeforeRef = !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
    return { selector: m.selector, ref, found: true, refFound: true, inPlace: m.before ? elBeforeRef : !elBeforeRef,
      firstY: el.getBoundingClientRect().top + scrollY, visible: vis(el) };
  });
  return { hide, move, textLen: document.body ? document.body.innerText.length : 0 };
}

// The machine-checkable assertion. A patch passes only if:
//  precondition: every hide target is visible and every move is NOT yet in place (no vacuous passes)
//  postcondition: every hide target has 0 visible matches, every move is in place
//  sanity: the page wasn't gutted (text kept, hidden area bounded)
function judge(before, after) {
  const problems = [];
  before.hide.forEach(h => {
    if (h.invalid) problems.push(`invalid selector: ${h.selector}`);
    else if (h.visible === 0) problems.push(`precondition: "${h.selector}" matched ${h.matched} elements, 0 visible before patch`);
    // Precision: a bare tag ("aside", "nav") hitting several elements hides more than was asked for.
    else if (/^[a-z][a-z0-9-]*$/i.test(h.selector.trim()) && h.visible > 1) problems.push(`precision: bare tag selector "${h.selector}" matches ${h.visible} visible elements; qualify it with an id, class or attribute so only the requested element is hidden`);
  });
  before.move.forEach(m => {
    if (!m.found) problems.push(`precondition: move selector "${m.selector}" not found`);
    else if (!m.refFound) problems.push(`precondition: move anchor "${m.ref}" not found`);
    else if (m.inPlace) problems.push(`precondition: "${m.selector}" is already positioned relative to "${m.ref}" (nothing to move)`);
  });
  after.hide.forEach(h => { if (!h.invalid && h.visible > 0) problems.push(`postcondition: "${h.selector}" still has ${h.visible} visible elements`); });
  after.move.forEach(m => { if (!m.inPlace) problems.push(`postcondition: "${m.selector}" not moved relative to "${m.ref}"`); });
  const hiddenArea = before.hide.reduce((a, h) => a + (h.areaFrac || 0), 0);
  if (hiddenArea > 0.7) problems.push(`sanity: patch hides ${(hiddenArea * 100).toFixed(0)}% of the page area`);
  if (before.textLen > 0 && after.textLen < before.textLen * 0.2) problems.push(`sanity: page text dropped from ${before.textLen} to ${after.textLen} chars`);
  if (!before.hide.length && !before.move.length) problems.push('empty patch');
  return { pass: problems.length === 0, problems };
}

// Scroll to the first patched region so before/after screenshots show the change.
function focusY(before) {
  const ys = [...before.hide, ...before.move].map(x => x.firstY).filter(y => typeof y === 'number');
  return ys.length ? Math.max(0, Math.min(...ys) - 120) : 0;
}

async function verify(url, spec, script, { shots } = {}) {
  const s = { hide: spec.hide || [], move: spec.move || [] };
  const pre = await openPage(url);
  let before, after, y = 0, shotBefore, shotAfter;
  try {
    if (pre.blocked) return { pass: false, blocked: pre.blocked, problems: [`site blocked us: ${pre.blocked}`] };
    before = await pre.page.evaluate(measureInPage, s);
    y = focusY(before);
    if (shots) {
      await pre.page.evaluate(v => window.scrollTo(0, v), y);
      await pre.page.waitForTimeout(400);
      shotBefore = await pre.page.screenshot({ path: shots.before, type: 'jpeg', quality: 70 });
    }
  } finally { await pre.ctx.close(); }
  // Second, independent load with the userscript injected at document-start: how Tampermonkey runs it.
  const post = await openPage(url, script);
  try {
    if (post.blocked) return { pass: false, blocked: post.blocked, problems: [`site blocked us: ${post.blocked}`] };
    after = await post.page.evaluate(measureInPage, s);
    if (shots) {
      await post.page.evaluate(v => window.scrollTo(0, v), y);
      await post.page.waitForTimeout(400);
      shotAfter = await post.page.screenshot({ path: shots.after, type: 'jpeg', quality: 70 });
    }
  } finally { await post.ctx.close(); }
  const verdict = judge(before, after);
  // The DOM can say "moved" or "hidden" while the user sees nothing different (a duplicate
  // element, an off-screen node). Identical screenshots of the patched region mean no visible effect.
  if (shotBefore && shotAfter && shotBefore.equals(shotAfter)) {
    verdict.problems.push('visible effect: the before and after screenshots of the patched region are pixel-identical; the targeted element is not what the user sees');
    verdict.pass = false;
  }
  return { ...verdict, before, after, scrollY: y };
}

module.exports = { outline, verify, judge, closeBrowser, outlineInPage, measureInPage, VIEWPORT };
