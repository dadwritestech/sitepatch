// Compiles a patch spec { title, hide: [css], move: [{selector, before|after}] } into a userscript.
// The runtime is fixed and small; only the spec (data) comes from the LLM.
const RUNTIME = `(function () {
  'use strict';
  var STYLE_ID = 'sitepatch-' + PATCH.slug;
  function css() {
    return PATCH.hide.map(function (s) { return s + '{display:none!important}'; }).join(' ');
  }
  var sheet = null;
  function ensureStyle() {
    if (!PATCH.hide.length) return;
    // Constructable stylesheet first: exists before <head>, survives SPA head rewrites.
    if (!sheet && window.CSSStyleSheet && 'adoptedStyleSheets' in document) {
      try {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(css());
      } catch (e) { sheet = false; }
    }
    if (sheet && document.adoptedStyleSheets.indexOf(sheet) < 0) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sheet]);
    }
    if (!sheet && !document.getElementById(STYLE_ID) && document.documentElement) {
      var st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = css();
      (document.head || document.documentElement).appendChild(st);
    }
  }
  function q(s) { try { return document.querySelector(s); } catch (e) { return null; } }
  function applyMoves() {
    PATCH.move.forEach(function (m) {
      var el = q(m.selector), ref = q(m.before || m.after);
      if (!el || !ref || el === ref || el.contains(ref) || !ref.parentNode) return;
      if (m.before && el.nextElementSibling !== ref) ref.parentNode.insertBefore(el, ref);
      if (m.after && ref.nextElementSibling !== el) ref.parentNode.insertBefore(el, ref.nextSibling);
    });
  }
  var queued = false;
  function apply() {
    queued = false;
    ensureStyle();
    applyMoves();
  }
  apply();
  // Single-page apps re-render; re-apply on DOM changes, debounced to one pass per frame.
  new MutationObserver(function () {
    if (!queued) { queued = true; (window.requestAnimationFrame || setTimeout)(apply); }
  }).observe(document, { childList: true, subtree: true }); // document, not documentElement: at document-start the latter may not exist yet
})();`;

function normalizeSpec(spec, slug) {
  return {
    slug: slug || spec.slug,
    title: String(spec.title || slug).slice(0, 80),
    hide: (spec.hide || []).filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()),
    move: (spec.move || []).filter(m => m && m.selector && (m.before || m.after))
      .map(m => (m.before ? { selector: m.selector, before: m.before } : { selector: m.selector, after: m.after })),
  };
}

function compile(spec, { host, match, version = '1.0.0', description = '' }) {
  const s = normalizeSpec(spec);
  const header = [
    '// ==UserScript==',
    `// @name         sitepatch: ${s.title}`,
    '// @namespace    https://github.com/dadwritestech/sitepatch',
    `// @version      ${version}`,
    `// @description  ${description.replace(/\n/g, ' ').slice(0, 200)}`,
    `// @match        ${match || `*://${host}/*`}`,
    '// @grant        none',
    '// @run-at       document-start',
    '// ==/UserScript==',
  ].join('\n');
  const data = `var PATCH = ${JSON.stringify({ slug: s.slug, hide: s.hide, move: s.move }, null, 2)};`;
  return `${header}\n// Generated and verified by sitepatch. Edit the PATCH data, not the runtime.\n${data}\n${RUNTIME}\n`;
}

// Recover the spec from an existing .user.js (used by retest/repair).
function extractSpec(source) {
  const m = source.match(/var PATCH = (\{[\s\S]*?\n\});/);
  if (!m) throw new Error('no PATCH block found');
  return JSON.parse(m[1]);
}

module.exports = { compile, extractSpec, normalizeSpec };
