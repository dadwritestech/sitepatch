// generate -> verify -> retry -> save, and the retest/repair loop.
const fs = require('node:fs');
const path = require('node:path');
const { chat, MODEL } = require('./llm');
const { outline, verify } = require('./browser');
const { compile, extractSpec, normalizeSpec } = require('./userscript');
const { checkRequest, checkSpec } = require('./safety');
const { matchFor } = require('./request');

const ROOT = path.resolve(__dirname, '..');
const PATCHES = process.env.SITEPATCH_PATCHES || path.join(ROOT, 'patches');
const MAX_ATTEMPTS = Number(process.env.SITEPATCH_ATTEMPTS || 3);

const SYSTEM = `You write website patches for sitepatch, a registry of userscripts that ONLY hide or rearrange page elements.
You are given a user request and an outline of the live page (selector-ish labels, y position, height, text).
Return ONLY JSON:
{"title": "<short title, e.g. Hacker News: hide footer>",
 "hide": ["<css selector>", ...],
 "move": [{"selector": "<css selector of element to move>", "before": "<css selector of sibling anchor>"}],
 "explanation": "<one sentence>"}
Rules:
- Identify the element by its text/heading in the outline, then use the selector of its container line. Use "hide" for hiding/removing/decluttering. Use "move" (with "before" or "after") only for reordering; the anchor should be a sibling of the moved element.
- Standard CSS selectors only (:has() is fine; NO jQuery like :contains or :eq). Build selectors ONLY from ids, classes and attributes that appear in the outline. Prefer #ids, [aria-label], [data-testid], [role] and semantic classes; avoid hashed classes and :nth-child.
- Each hide selector must match the thing the user asked about and be visible now. Be precise: never hide body, main, html, or a wrapper holding most of the page.
- Fewer, more precise selectors are better than many guesses. Use [] for an unused list.
- Never target paywalls, ads, consent/cookie dialogs, login prompts or CAPTCHAs.`;

function userPrompt({ host, url, request, page, feedback, previous }) {
  let p = `Site: ${host}\nURL: ${url}\nPage title: ${page.title}\nRequest: ${request}\n\nPage outline:\n${page.outline}`;
  if (previous) p += `\n\nPrevious patch attempt:\n${JSON.stringify({ hide: previous.hide, move: previous.move })}`;
  if (feedback) p += `\n\nThat attempt FAILED verification in a real browser:\n- ${feedback.join('\n- ')}\nFix the selectors using the outline above.`;
  return p;
}

function writePatch({ host, slug, url, request, spec, result, attempts, shotsTmp, prevMeta, repaired }) {
  const dir = path.join(PATCHES, host);
  fs.mkdirSync(dir, { recursive: true });
  const version = prevMeta ? bump(prevMeta.version, repaired) : '1.0.0';
  const description = `${request} (verified by sitepatch)`;
  const match = matchFor(url);
  const source = compile({ ...spec, slug }, { host, match, version, description });
  fs.writeFileSync(path.join(dir, `${slug}.user.js`), source);
  for (const k of ['before', 'after']) if (shotsTmp && fs.existsSync(shotsTmp[k])) {
    fs.copyFileSync(shotsTmp[k], path.join(dir, `${slug}.${k}.jpg`)); // copy, not rename: tmp may be on another drive
    fs.rmSync(shotsTmp[k]);
  }
  const now = new Date().toISOString();
  const history = [...((prevMeta && prevMeta.history) || []), { at: now, event: repaired ? 'repaired' : prevMeta ? 'retest' : 'created', pass: result.pass, attempts }];
  const meta = {
    host, slug, title: spec.title, request, testUrl: url, match, version, model: MODEL,
    assertion: describeAssertion(spec),
    status: result.pass ? (repaired ? 'repaired' : 'pass') : result.blocked ? 'blocked' : 'fail',
    lastVerified: now, problems: result.problems || [],
    createdAt: (prevMeta && prevMeta.createdAt) || now,
    history: history.slice(-30),
  };
  // A human audit is about one specific script: it survives a plain retest, not a repair.
  if (prevMeta && prevMeta.audit && prevMeta.audit.version === version) meta.audit = prevMeta.audit;
  fs.writeFileSync(path.join(dir, `${slug}.meta.json`), JSON.stringify(meta, null, 2) + '\n');
  return meta;
}

function bump(v, minor) {
  const [a, b, c] = String(v || '1.0.0').split('.').map(Number);
  return minor ? `${a}.${b + 1}.0` : `${a}.${b}.${c}`;
}

function describeAssertion(spec) {
  return [
    ...(spec.hide || []).map(s => `visible("${s}") > 0 before AND == 0 after`),
    ...(spec.move || []).map(m => `"${m.selector}" ${m.before ? 'precedes' : 'follows'} "${m.before || m.after}" after (not before)`),
  ];
}

function tmpShots(slug) {
  const dir = path.join(ROOT, 'out', 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return { before: path.join(dir, `${slug}.before.jpg`), after: path.join(dir, `${slug}.after.jpg`) };
}

const sameTargets = (a, b) => JSON.stringify([a.hide, a.move]) === JSON.stringify([b.hide, b.move]);

// The agent loop shared by `create` and `repair`.
async function solve({ host, url, request, slug, previous, initialFeedback, rejected, log = console.log }) {
  const page = await outline(url);
  if (page.blocked) return { result: { pass: false, blocked: page.blocked, problems: [`site blocked us: ${page.blocked}`] }, attempts: 0 };
  let feedback = initialFeedback, prev = previous, spec, result, attempt;
  for (attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    let raw;
    try {
      raw = await chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt({ host, url, request, page, feedback, previous: prev }) }],
        { temperature: attempt === 1 ? 0.2 : 0.6 });
    } catch (e) {
      log(`  attempt ${attempt}: LLM error: ${e.message}`);
      result = { pass: false, problems: [`llm: ${e.message}`] };
      if (/timeout|ECONNREFUSED/.test(e.message)) break; // shared server is stuck: stop, don't hammer it
      continue;
    }
    spec = normalizeSpec(raw, slug);
    const safe = checkSpec(spec);
    if (!safe.ok) { result = { pass: false, problems: [`refused: ${safe.reason}`] }; log(`  attempt ${attempt}: ${result.problems[0]}`); break; }
    if (rejected && sameTargets(spec, rejected)) {
      result = { pass: false, problems: [`these are exactly the selectors a human already rejected (${JSON.stringify(rejected.hide)}); they target the wrong element. Use different selectors.`] };
      log(`  attempt ${attempt}: resubmitted the rejected patch`);
      feedback = result.problems; prev = spec;
      continue;
    }
    const script = compile(spec, { host, match: matchFor(url) });
    result = await verify(url, spec, script, { shots: tmpShots(slug) });
    log(`  attempt ${attempt} (${((Date.now() - t0) / 1000).toFixed(0)}s): ${result.pass ? 'PASS' : 'FAIL'} hide=${JSON.stringify(spec.hide)} move=${JSON.stringify(spec.move)}`);
    if (result.pass || result.blocked) break;
    result.problems.forEach(p => log(`    - ${p}`));
    feedback = result.problems;
    prev = spec;
  }
  return { spec, result, attempts: Math.min(attempt, MAX_ATTEMPTS) };
}

async function create(req, { log = console.log, saveFailures = false } = {}) {
  const gate = checkRequest(req.request);
  if (!gate.ok) throw new Error(`refused (${gate.reason}). sitepatch only hides or rearranges page elements.`);
  log(`sitepatch: ${req.host} — "${req.request}"`);
  const { spec, result, attempts } = await solve({ ...req, log });
  if (!spec || (!result.pass && !saveFailures)) return { pass: false, result, attempts };
  const meta = writePatch({ ...req, spec, result, attempts, shotsTmp: tmpShots(req.slug) });
  return { pass: result.pass, meta, attempts, result };
}

function listPatches() {
  if (!fs.existsSync(PATCHES)) return [];
  return fs.readdirSync(PATCHES).flatMap(host => {
    const dir = path.join(PATCHES, host);
    if (!fs.statSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.meta.json')).map(f => {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { meta, dir, scriptPath: path.join(dir, `${meta.slug}.user.js`) };
    });
  });
}

// Re-verify every patch against the live site. On failure, ask the agent to repair it.
async function retest({ repair = true, only, log = console.log } = {}) {
  const rows = [];
  for (const { meta, scriptPath } of listPatches()) {
    if (only && !`${meta.host}/${meta.slug}`.includes(only)) continue;
    const source = fs.readFileSync(scriptPath, 'utf8');
    const spec = { ...extractSpec(source), title: meta.title };
    log(`retest ${meta.host}/${meta.slug}`);
    let result = await verify(meta.testUrl, spec, source, { shots: tmpShots(meta.slug) });
    let outcome = result.pass ? 'pass' : result.blocked ? 'blocked' : 'fail';
    log(`  ${outcome}${result.problems.length ? ': ' + result.problems.join('; ') : ''}`);
    // Passing the assertion is not enough if a human audit of this exact version said it hides the wrong thing:
    // that verdict is the repair feedback.
    const audited = meta.audit && meta.audit.correct === false && meta.audit.version === meta.version;
    if (result.pass && audited && repair) {
      log(`  human audit says wrong target: ${meta.audit.why}; attempting agent repair…`);
      const fixed = await solve({ host: meta.host, url: meta.testUrl, request: meta.request, slug: meta.slug, previous: spec, rejected: spec,
        initialFeedback: [`a human compared the before/after screenshots: the patch passes the DOM check but ${meta.audit.why}. Choose a different element that matches the request.`], log });
      if (fixed.result.pass) {
        writePatch({ ...meta, url: meta.testUrl, spec: { ...fixed.spec, title: meta.title }, result: fixed.result, attempts: fixed.attempts, shotsTmp: tmpShots(meta.slug), prevMeta: meta, repaired: true });
        outcome = 'repaired (unaudited)';
      } else {
        writePatch({ ...meta, url: meta.testUrl, spec, result, attempts: fixed.attempts, shotsTmp: null, prevMeta: meta });
        outcome = 'wrong target';
      }
      log(`  audit repair: ${outcome}`);
    } else if (result.pass || result.blocked) {
      writePatch({ ...meta, url: meta.testUrl, spec, result, attempts: 0, shotsTmp: result.pass ? tmpShots(meta.slug) : null, prevMeta: meta });
    } else if (repair) {
      log('  attempting agent repair…');
      const fixed = await solve({ host: meta.host, url: meta.testUrl, request: meta.request, slug: meta.slug, previous: spec, initialFeedback: result.problems, log });
      if (fixed.result.pass) {
        writePatch({ ...meta, url: meta.testUrl, spec: { ...fixed.spec, title: meta.title }, result: fixed.result, attempts: fixed.attempts, shotsTmp: tmpShots(meta.slug), prevMeta: meta, repaired: true });
        outcome = 'repaired';
      } else {
        writePatch({ ...meta, url: meta.testUrl, spec, result, attempts: fixed.attempts, shotsTmp: null, prevMeta: meta });
      }
      log(`  repair ${outcome === 'repaired' ? 'succeeded' : 'failed'}`);
    } else {
      writePatch({ ...meta, url: meta.testUrl, spec, result, attempts: 0, shotsTmp: null, prevMeta: meta });
    }
    rows.push({ id: `${meta.host}/${meta.slug}`, outcome });
  }
  return rows;
}

module.exports = { create, retest, solve, listPatches, writePatch, describeAssertion, PATCHES, SYSTEM, userPrompt };
