// sitepatch only hides and rearranges. Anything that smells like circumventing
// a business or security control is refused before the LLM ever sees it.
const BLOCKED = [
  [/pay\s*wall|metered|free articles?|premium|unlock|subscriber[- ]only|members?[- ]only/i, 'paywall circumvention'],
  [/\bads?\b|advert|sponsored|promoted|ad[- ]?block|tracking pixel/i, 'ad blocking / ads policy'],
  [/\bdrm\b|widevine|download (limit|restriction|button)|rip |save (the )?video|bypass/i, 'DRM / download limits / bypassing'],
  [/captcha|recaptcha|hcaptcha|turnstile|bot check|cloudflare/i, 'CAPTCHA / bot checks'],
  [/log ?in|sign ?in|password|credential|cookie (banner|consent|wall)|consent/i, 'login / consent walls'],
];

function checkRequest(text) {
  for (const [re, why] of BLOCKED) if (re.test(text)) return { ok: false, reason: why };
  return { ok: true };
}

// Generated selectors get the same scrutiny: a "declutter" that targets a paywall node is still a paywall bypass.
const SELECTOR_BLOCK = /paywall|piano|tp-modal|regwall|adblock|captcha|consent|gdpr|cookie|\bad-|-ad\b|sponsor|advert/i;
function checkSpec(spec) {
  const sels = [...(spec.hide || []), ...(spec.move || []).flatMap(m => [m.selector, m.before, m.after])].filter(Boolean);
  const bad = sels.find(s => SELECTOR_BLOCK.test(s));
  return bad ? { ok: false, reason: `selector "${bad}" targets a blocked category` } : { ok: true };
}

module.exports = { checkRequest, checkSpec };
