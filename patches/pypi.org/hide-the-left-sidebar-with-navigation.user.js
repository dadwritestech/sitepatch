// ==UserScript==
// @name         sitepatch: PyPI: hide project sidebar
// @namespace    https://github.com/dadwritestech/sitepatch
// @version      1.0.0
// @description  hide the left sidebar with navigation, project links and classifiers (verified by sitepatch)
// @match        *://pypi.org/project/requests/*
// @grant        none
// @run-at       document-start
// ==/UserScript==
// Generated and verified by sitepatch. Edit the PATCH data, not the runtime.
var PATCH = {
  "slug": "hide-the-left-sidebar-with-navigation",
  "hide": [
    ".project-description__sidebar"
  ],
  "move": []
};
(function () {
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
})();
