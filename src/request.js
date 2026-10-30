// "<domain>[/path]: <request>" -> { host, url, request, slug }
function parseRequest(arg) {
  const m = String(arg || '').match(/^\s*([^\s:]+(?:\/[^\s:]*)?)\s*:\s*(.+)$/);
  if (!m) throw new Error('usage: sitepatch "<domain>: <request>"  e.g. sitepatch "news.ycombinator.com: hide the footer"');
  let target = m[1].replace(/^https?:\/\//, '');
  const host = target.split('/')[0].toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new Error(`not a domain: ${host}`);
  const url = 'https://' + target;
  return { host, url, request: m[2].trim(), slug: slugify(m[2]), match: matchFor(url) };
}

// A patch only claims the pages it was verified on: the test URL's path and below.
// "example.com" -> front page only; "example.com/wiki/Foo" -> *://example.com/wiki/Foo*
function matchFor(url) {
  const u = new URL(url);
  return u.pathname === '/' ? `*://${u.hostname}/` : `*://${u.hostname}${u.pathname}*`;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 6).join('-') || 'patch';
}

module.exports = { parseRequest, slugify, matchFor };
