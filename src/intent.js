// Intent check: the DOM assertion proves the chosen selector is hidden, not that it is
// the thing the user meant. A vision model compares before/after screenshots against the request.
const fs = require('node:fs');
const { chat } = require('./llm');

const PROMPT = `You audit website patches. The user asked for a change to a web page.
Image 1 is BEFORE the patch, image 2 is AFTER (same scroll position).
Request: "{REQUEST}"
Compare the two images carefully. Name what disappeared or moved between them.
Return ONLY JSON: {"changed": "<what visibly disappeared or moved>", "fulfils_request": true|false, "removed_unrequested": true|false, "reason": "<one sentence>"}
- fulfils_request is false if the element that changed is not the one requested (e.g. a different section, a toolbar instead of a sidebar), or if nothing visibly changed.
- removed_unrequested is true if clearly more was removed than requested (e.g. both sidebars when one was asked for).`;

const dataUri = p => `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}`;

async function checkIntent(request, beforeJpg, afterJpg) {
  const r = await chat([{ role: 'user', content: [
    { type: 'text', text: PROMPT.replace('{REQUEST}', request) },
    { type: 'image_url', image_url: { url: dataUri(beforeJpg) } },
    { type: 'image_url', image_url: { url: dataUri(afterJpg) } },
  ] }], { temperature: 0, maxTokens: 300 });
  return { ok: r.fulfils_request === true && r.removed_unrequested !== true, ...r };
}

module.exports = { checkIntent };
