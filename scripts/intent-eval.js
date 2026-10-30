// Measures the vision intent check against hand labels (docs/audit-labels.json).
const fs = require('node:fs');
const path = require('node:path');
const { checkIntent } = require('../src/intent');
const labels = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'audit-labels.json'), 'utf8'));
(async () => {
  const rows = [];
  for (const [id, human] of Object.entries(labels.labels)) {
    const [host, slug] = id.split('/');
    const dir = path.join(__dirname, '..', 'patches', host);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${slug}.meta.json`), 'utf8'));
    const t0 = Date.now();
    const args = [meta.request, path.join(dir, `${slug}.before.jpg`), path.join(dir, `${slug}.after.jpg`)];
    let r;
    try { r = await checkIntent(...args); } catch (e) {
      try { await new Promise(res => setTimeout(res, 5000)); r = await checkIntent(...args); }
      catch (e2) { console.log(`ERROR    ${id}: ${e2.message}`); rows.push({ id, human: human.correct, model: null, error: e2.message }); continue; }
    }
    rows.push({ id, human: human.correct, model: r.ok, changed: r.changed, reason: r.reason, s: Math.round((Date.now() - t0) / 1000) });
    console.log(`${human.correct === r.ok ? 'agree   ' : 'DISAGREE'} human=${human.correct ? 'ok ' : 'bad'} model=${r.ok ? 'ok ' : 'bad'} ${id} (${rows.at(-1).s}s) :: ${r.changed} | ${r.reason}`);
  }
  const scored = rows.filter(r => r.model !== null);
  const agree = scored.filter(r => r.human === r.model).length;
  const caught = scored.filter(r => !r.human && !r.model).length, bad = scored.filter(r => !r.human).length;
  const falseRej = scored.filter(r => r.human && !r.model).length;
  console.log(`\nagreement ${agree}/${scored.length} (${rows.length - scored.length} errors); caught ${caught}/${bad} wrong patches; falsely rejected ${falseRej}/${scored.length - bad} good ones`);
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'intent-eval.json'), JSON.stringify({ at: new Date().toISOString(), agree, n: scored.length, errors: rows.length - scored.length, caught, bad, falseRej, rows }, null, 2) + '\n');
})();
