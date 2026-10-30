// Copies hand-audit verdicts (docs/audit-labels.json) into each patch's meta.json,
// pinned to the script version that was audited.
const fs = require('node:fs');
const path = require('node:path');
const { PATCHES } = require('../src/patch');
const { labels, how } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'audit-labels.json'), 'utf8'));
for (const [id, l] of Object.entries(labels)) {
  const [host, slug] = id.split('/');
  const f = path.join(PATCHES, host, `${slug}.meta.json`);
  if (!fs.existsSync(f)) { console.log(`skip ${id} (no patch)`); continue; }
  const meta = JSON.parse(fs.readFileSync(f, 'utf8'));
  meta.audit = { correct: l.correct, why: l.why || '', version: meta.version, by: 'human, before/after screenshots', how };
  fs.writeFileSync(f, JSON.stringify(meta, null, 2) + '\n');
  console.log(`${l.correct ? 'ok   ' : 'WRONG'} ${id} v${meta.version}`);
}
