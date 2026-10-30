// Offline tests: a local fixture site + a fake LLM server exercise the real pipeline
// (real Chromium, real verifier) without touching the network or the shared llama-server.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepatch-'));
process.env.SITEPATCH_PATCHES = path.join(TMP, 'patches');
process.env.SITEPATCH_SETTLE_MS = '800';

const FIXTURE = `<!doctype html><html><head><title>Fixture</title></head><body>
<header id="top">Site header</header>
<main id="content"><h1>Article</h1><p>${'Lorem ipsum dolor sit amet. '.repeat(40)}</p>
<section id="syntax"><h2>Syntax</h2><p>syntax text</p></section>
<section id="examples"><h2>Examples</h2><p>examples text</p></section></main>
<aside class="trending"><h3>Trending now</h3><ul><li>a</li><li>b</li></ul></aside>
<div class="already-hidden" style="display:none">ghost</div>
<div class="phantom" style="position:absolute;top:0;left:0;opacity:0">phantom</div>
<script>setTimeout(()=>{const d=document.createElement('aside');d.className='trending late';d.textContent='late trending';document.body.appendChild(d)},300)</script>
</body></html>`;

// Fake LLM: replays scripted responses in order, recording prompts.
const llmQueue = [];
const prompts = [];
let site, llm, base;

function listen(handler) {
  return new Promise(r => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
}

test.before(async () => {
  site = await listen((req, res) => { res.setHeader('content-type', 'text/html'); res.end(FIXTURE); });
  base = `http://127.0.0.1:${site.address().port}`;
  llm = await listen((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      prompts.push(JSON.parse(body).messages);
      const content = JSON.stringify(llmQueue.shift() || { hide: [], move: [] });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  process.env.SITEPATCH_LLM_URL = `http://127.0.0.1:${llm.address().port}/v1/chat/completions`;
});

test.after(async () => {
  await require('../src/browser').closeBrowser();
  site.close(); llm.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('parseRequest: domain, path, slug, match scope', () => {
  const { parseRequest } = require('../src/request');
  const r = parseRequest('news.ycombinator.com: Hide the footer!');
  assert.deepStrictEqual([r.host, r.url, r.slug, r.match], ['news.ycombinator.com', 'https://news.ycombinator.com', 'hide-the-footer', '*://news.ycombinator.com/']);
  const w = parseRequest('en.wikipedia.org/wiki/Cat: hide the sidebar');
  assert.strictEqual(w.match, '*://en.wikipedia.org/wiki/Cat*');
  assert.throws(() => parseRequest('no colon here'), /usage/);
  assert.throws(() => parseRequest('localhost: hide x'), /not a domain/);
});

test('safety: refuses paywall, ads, DRM, CAPTCHA, login requests', () => {
  const { checkRequest, checkSpec } = require('../src/safety');
  for (const bad of ['remove the paywall', 'hide sponsored results', 'hide ads', 'enable the download button', 'skip the captcha', 'hide the login wall', 'dismiss the cookie consent'])
    assert.strictEqual(checkRequest(bad).ok, false, bad);
  for (const ok of ['hide the footer', 'move the README above the file list', 'hide Shorts', 'hide the Trending sidebar'])
    assert.strictEqual(checkRequest(ok).ok, true, ok);
  assert.strictEqual(checkSpec({ hide: ['.tp-modal'] }).ok, false);
  assert.strictEqual(checkSpec({ hide: ['#paywall-overlay'] }).ok, false);
  assert.strictEqual(checkSpec({ hide: ['aside.trending'], move: [] }).ok, true);
});

test('compile: valid JS, userscript header, spec round-trips', () => {
  const { compile, extractSpec } = require('../src/userscript');
  const src = compile({ slug: 's', title: 'T', hide: ['a.b', "x[y='z']"], move: [{ selector: '#a', before: '#b' }] },
    { host: 'example.com', match: '*://example.com/' });
  new vm.Script(src); // throws on syntax error (this caught a real bug)
  assert.match(src, /\/\/ ==UserScript==[\s\S]*@match\s+\*:\/\/example\.com\/\n[\s\S]*@grant\s+none/);
  assert.deepStrictEqual(extractSpec(src), { slug: 's', hide: ['a.b', "x[y='z']"], move: [{ selector: '#a', before: '#b' }] });
});

test('judge: rejects vacuous, failed, and page-gutting patches', () => {
  const { judge } = require('../src/browser');
  const h = (visible, areaFrac = 0.1) => ({ selector: '.s', matched: visible, visible, areaFrac });
  assert.ok(judge({ hide: [h(2)], move: [], textLen: 100 }, { hide: [h(0)], move: [], textLen: 90 }).pass);
  assert.match(judge({ hide: [h(0)], move: [], textLen: 100 }, { hide: [h(0)], move: [], textLen: 100 }).problems[0], /precondition/);
  assert.match(judge({ hide: [h(1)], move: [], textLen: 100 }, { hide: [h(1)], move: [], textLen: 100 }).problems[0], /postcondition/);
  assert.match(judge({ hide: [h(1, 0.9)], move: [], textLen: 100 }, { hide: [h(0)], move: [], textLen: 100 }).problems.join(), /sanity/);
  assert.match(judge({ hide: [h(1)], move: [], textLen: 1000 }, { hide: [h(0)], move: [], textLen: 10 }).problems.join(), /text dropped/);
  const bare = { selector: 'aside', matched: 2, visible: 2, areaFrac: 0.1 };
  assert.match(judge({ hide: [bare], move: [], textLen: 100 }, { hide: [{ ...bare, visible: 0 }], move: [], textLen: 90 }).problems[0], /precision/);
  const single = { selector: 'form', matched: 1, visible: 1, areaFrac: 0.01 };
  assert.ok(judge({ hide: [single], move: [], textLen: 100 }, { hide: [{ ...single, visible: 0 }], move: [], textLen: 90 }).pass);
  const mv = inPlace => ({ selector: '#a', ref: '#b', found: true, refFound: true, inPlace });
  assert.ok(judge({ hide: [], move: [mv(false)], textLen: 1 }, { hide: [], move: [mv(true)], textLen: 1 }).pass);
  assert.match(judge({ hide: [], move: [mv(true)], textLen: 1 }, { hide: [], move: [mv(true)], textLen: 1 }).problems[0], /already/);
});

test('verify (real browser): hides late-rendered elements and moves sections', async () => {
  const { verify } = require('../src/browser');
  const { compile } = require('../src/userscript');
  const spec = { slug: 'v', hide: ['aside.trending'], move: [{ selector: '#examples', before: '#syntax' }] };
  const r = await verify(base + '/', spec, compile(spec, { host: '127.0.0.1' }));
  assert.ok(r.pass, r.problems.join('; '));
  assert.strictEqual(r.after.hide[0].matched, 2, 'the late-inserted aside was matched too');
  assert.strictEqual(r.after.hide[0].visible, 0);
});

test('verify: an already-hidden target is a vacuous patch and fails', async () => {
  const { verify } = require('../src/browser');
  const { compile } = require('../src/userscript');
  const spec = { slug: 'g', hide: ['.already-hidden'], move: [] };
  const r = await verify(base + '/', spec, compile(spec, { host: '127.0.0.1' }));
  assert.strictEqual(r.pass, false);
  assert.match(r.problems[0], /0 visible before/);
});

test('verify: a patch with no visible effect (identical screenshots) fails', async () => {
  const { verify } = require('../src/browser');
  const { compile } = require('../src/userscript');
  const spec = { slug: 'ph', hide: ['.phantom'], move: [] };
  const shots = { before: path.join(TMP, 'ph.before.jpg'), after: path.join(TMP, 'ph.after.jpg') };
  const r = await verify(base + '/', spec, compile(spec, { host: '127.0.0.1' }), { shots });
  assert.strictEqual(r.pass, false);
  assert.match(r.problems.join(), /pixel-identical/);
});

test('create: retries with browser feedback, then saves script + meta + screenshots', async () => {
  const { create, listPatches } = require('../src/patch');
  llmQueue.push({ title: 'Fixture: hide trending', hide: ['#trending-box'], move: [] }); // hallucinated
  llmQueue.push({ title: 'Fixture: hide trending', hide: ['aside.trending'], move: [] });
  const r = await create({ host: '127.0.0.1', url: base + '/', request: 'hide the trending sidebar', slug: 'hide-trending' }, { log: () => {} });
  assert.ok(r.pass);
  assert.strictEqual(r.attempts, 2);
  const retryPrompt = prompts.at(-1)[1].content;
  assert.match(retryPrompt, /FAILED verification/);
  assert.match(retryPrompt, /#trending-box/);
  assert.match(prompts.at(-1)[1].content, /aside\.trending/, 'outline shows the real selector');
  const [p] = listPatches();
  assert.strictEqual(p.meta.status, 'pass');
  for (const f of ['user.js', 'before.jpg', 'after.jpg']) assert.ok(fs.existsSync(path.join(p.dir, `hide-trending.${f}`)), f);
});

test('create: refuses blocked requests before calling the LLM', async () => {
  const { create } = require('../src/patch');
  const n = prompts.length;
  await assert.rejects(create({ host: 'x.com', url: 'https://x.com', request: 'remove the paywall', slug: 'p' }, { log: () => {} }), /refused/);
  assert.strictEqual(prompts.length, n);
});

test('retest: broken patch is detected and repaired by the agent', async () => {
  const { retest, listPatches } = require('../src/patch');
  const { compile } = require('../src/userscript');
  const p = listPatches().find(x => x.meta.slug === 'hide-trending');
  // Simulate a site redesign: the saved selector no longer exists.
  fs.writeFileSync(p.scriptPath, compile({ slug: 'hide-trending', hide: ['div.old-trending'], move: [] }, { host: '127.0.0.1' }));
  llmQueue.push({ hide: ['aside.trending'], move: [] });
  const rows = await retest({ log: () => {} });
  assert.deepStrictEqual(rows, [{ id: '127.0.0.1/hide-trending', outcome: 'repaired' }]);
  const meta = listPatches()[0].meta;
  assert.strictEqual(meta.status, 'repaired');
  assert.strictEqual(meta.version, '1.1.0');
  assert.deepStrictEqual(meta.history.map(h => h.event), ['created', 'repaired']);
  assert.match(fs.readFileSync(p.scriptPath, 'utf8'), /aside\.trending/);
});

test('audit: a passing patch flagged by a human shows as wrong target and gets repaired from that feedback', async () => {
  const { retest, listPatches } = require('../src/patch');
  const { build } = require('../src/registry');
  const p = listPatches()[0];
  fs.writeFileSync(path.join(p.dir, 'hide-trending.meta.json'),
    JSON.stringify({ ...p.meta, audit: { correct: false, why: 'it hid the header instead', version: p.meta.version } }, null, 2));
  const html = fs.readFileSync(build({ outDir: path.join(TMP, 'site-audit') }), 'utf8');
  assert.match(html, /wrong target \(audit\)/);
  assert.match(html, /0\/1/);
  llmQueue.push({ hide: ['aside.trending'], move: [] }); // the model resubmits the rejected patch first
  llmQueue.push({ hide: ['aside.trending', '#top'], move: [] });
  const rows = await retest({ log: () => {} });
  assert.match(prompts.at(-1)[1].content, /exactly the selectors a human already rejected/);
  assert.deepStrictEqual(rows, [{ id: '127.0.0.1/hide-trending', outcome: 'repaired (unaudited)' }]);
  assert.match(prompts.at(-2)[1].content, /a human compared the before\/after screenshots[\s\S]*hid the header instead/);
  const meta = listPatches()[0].meta;
  assert.strictEqual(meta.version, '1.2.0');
  assert.strictEqual(meta.audit, undefined, 'the old verdict does not carry over to new code');
});

test('registry: renders install links, badges and pass rate', () => {
  const { build } = require('../src/registry');
  const out = build({ outDir: path.join(TMP, 'site') });
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /hide-trending\.user\.js/);
  assert.match(html, /repaired/);
  assert.match(html, /1\/1/);
});
