# sitepatch

**Tell any website what to stop doing.**

```bash
sitepatch "news.ycombinator.com: hide the points, username and comment count line under each story"
```

An LLM writes a userscript. A real, logged-out Chromium proves the userscript works on the live site with before/after screenshots and a machine-checked assertion. The verified patch goes into a git registry you can install from with one click. A daily CI job re-tests every patch against the live site. When a redesign breaks one, an agent tries to repair it.

![before/after](docs/hero.gif)

## Results (v0, 2026-10-30, gemma-4-12b on a local llama-server)

![registry](docs/registry.png)

25 seed requests on public, logged-out pages, each allowed at most 3 attempts:

| | count |
|---|---|
| passed the DOM assertion and were saved | **18 / 25** (the first pass was 9/20; fixes to the outline, the null-body guard and block detection got it from there) |
| ...of those, actually correct by **human audit** of the before/after screenshots | **15 / 18**, so **15 / 25 overall (60%)** |
| first-try passes among the 18 | 16 (the other 2 needed one retry) |
| site blocked a headless, logged-out browser | 4: npmjs (403), old.reddit (403), Stack Overflow (challenge page), archive.org (shadow DOM, no light-DOM content) |
| model never produced valid CSS | 2: Guardian and Allrecipes (kept writing jQuery `:contains()`, even when told not to) |
| model picked the wrong section | 1: MDN "move Examples above Syntax" |

Median time per request: 20 s.

**What the audit found.** Passing the assertion proves the chosen selector disappeared, not that it was the thing you meant. I looked at every after-screenshot ([docs/audit-labels.json](docs/audit-labels.json)):

- **dev.to**: `aside` hid *both* sidebars. This added the **precision rule**: a bare tag matching more than one visible element fails. On the daily `retest`, that rule caught the patch and the agent repaired it to `#sidebar-wrapper-right` (v1.1.0, re-audited as correct). It is the one real self-heal in this run.
- **github.com/torvalds/linux "move README above files"**: the DOM move happened, but nothing visible changed. This added the **visible-effect guard** (pixel-identical before and after fails). `retest` now marks the patch broken. Repair failed 3 times: the model kept proposing moves that were already in place.
- **github.com/microsoft/vscode sidebar boxes**: hashed `Box_N__xyz` classes hid the branch toolbar instead of the About/Releases boxes.
- **BBC "Most read"**: it hid "Most watched".

The audit verdict is stored in each patch's meta, pinned to the script version. The registry shows **wrong target (audit)** for the last two, and `retest` feeds the human's sentence back to the agent as repair feedback. With gemma-4-12b, both repair attempts failed: it resubmitted the rejected selectors (which are now refused explicitly) or wrote `:contains()`. Both are still flagged.

**Can a vision model replace the human audit?** Not this one. Given the before/after pair and the request, gemma-4-12b agreed with my labels on 12/18 ([docs/intent-eval.json](docs/intent-eval.json)). It caught 2 of the 4 wrong patches (both "nothing changed" cases, which the free pixel check now covers) and wrongly rejected 4 of the 14 good ones. In one of those it claimed an ad had been removed; it was the same ad slot with a different creative. `src/intent.js` and `scripts/intent-eval.js` are kept as an eval, not as a gate.

**Limits.**
- One test URL per patch, and `@match` is scoped to that page.
- Only light DOM: shadow-DOM sites such as archive.org are out.
- Hiding leaves layout gaps; there is no reflow.
- "Logged out, headless, en-US, 1280×900" is the only configuration verified.
- Consent banners are never dismissed, so they sit in some screenshots (BBC).
- The daily CI workflow exists but has never run: there is no remote, and repair needs an LLM endpoint the runner can reach.


## How a patch is made

```
request ──► outline of the live page ──► LLM writes a patch spec ──► compile to .user.js
                                                │                          │
                                                │      feedback            ▼
                                                └─────────────── verify in Chromium (2 loads)
                                                   (≤3 attempts)   ├─ load 1: no patch → precondition + "before" shot
                                                                   └─ load 2: script at document-start → postcondition + "after" shot
```

- **The LLM writes a spec, not raw JS.** It outputs `{hide: [css], move: [{selector, before|after}]}`. A fixed runtime of about 50 lines compiles the spec into the userscript, and that runtime re-applies the patch on DOM changes, so SPAs stay patched. A one-click registry should not ship arbitrary code written by a 12B model into people's browsers. The spec is also what makes the assertion automatic.
- **The assertion is derived, not written by hand.** For every hidden selector, visible matches must be greater than 0 *before* the patch and exactly 0 *after*. For every move, the element must *not* be in place before and must be in place after. The precondition rules out vacuous passes: a hallucinated selector that matches nothing fails, and so does one that matches something already hidden.
- **Visible-effect guard:** if the before and after screenshots of the patched region are pixel-identical, the patch fails. The DOM can report "moved" for an element nobody sees.
- **Sanity guards:** a patch fails if it hides more than 70% of the page area, or if the page loses more than 80% of its text.
- **Verification runs the patch the way a userscript manager does:** a separate page load with the script injected at `document-start`, not a script evaluated into an already-loaded page.
- **`@match` is scoped to the verified URL.** A patch tested on `en.wikipedia.org/wiki/Web_browser` matches `*://en.wikipedia.org/wiki/Web_browser*`, not the whole site. A patch only claims pages where it was checked.
- **Retries feed the browser's verdict back to the model**, for example: `precondition: "#footer" matched 0 elements, 0 visible before patch`.

## Commands

```bash
npm install
npx playwright install chromium

# an OpenAI-compatible endpoint; defaults to a local llama-server with gemma-4-12b
export SITEPATCH_LLM_URL=http://localhost:8080/v1/chat/completions
export LLAMA_API_KEY=...          # if your server needs one
export SITEPATCH_MODEL=gemma-4-12b

node bin/sitepatch.js "dev.to: hide the right sidebar"
node bin/sitepatch.js retest                  # re-verify all, repair broken ones
node bin/sitepatch.js retest github.com --no-repair
node bin/sitepatch.js registry                # rebuild site/index.html
node scripts/seed.js                          # (re)run the seed set → docs/seed-run.json
node scripts/gif.js <host>/<slug>             # before/after GIF
node scripts/apply-audit.js                   # docs/audit-labels.json → meta.audit (pinned to version)
node scripts/intent-eval.js                   # vision-model intent check vs the hand labels
npm test                                      # offline: fixture site + fake LLM + real Chromium
```

Layout: `patches/<domain>/<slug>.user.js`, plus `.meta.json` (status, assertion, test URL, history) and `.before.jpg`/`.after.jpg`. The registry is `site/index.html`, plain static HTML.

## What it refuses

sitepatch only hides and rearranges. Before the LLM is called, it refuses requests about paywalls, ads or sponsored content, DRM, download limits, CAPTCHAs, logins and cookie or consent walls. It also refuses generated selectors that target those things. The verifier never logs in, never clicks, never accepts consent, and never solves a CAPTCHA. If a site serves a bot check, the patch is marked blocked and left alone.

## Daily CI

`.github/workflows/retest.yml` runs `retest` every day. It rebuilds the registry and commits the new statuses. Repair needs an LLM endpoint (secrets `SITEPATCH_LLM_URL` and `SITEPATCH_LLM_KEY`). Without one, broken patches still turn red.

## License

- **Tool:** [Apache-2.0](LICENSE).
- **Patches** (`patches/`): [MIT](patches/LICENSE), the userscript norm.
