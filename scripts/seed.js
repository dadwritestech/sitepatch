// Runs every request in seeds.txt through the real pipeline and records an honest log.
// Usage: node scripts/seed.js [filter]
const fs = require('node:fs');
const path = require('node:path');
const { parseRequest } = require('../src/request');
const { create } = require('../src/patch');
const { closeBrowser } = require('../src/browser');

(async () => {
  const args = process.argv.slice(2);
  const onlyFailed = args.includes('--failed'); // retry only requests that have not passed yet
  const only = args.find(a => !a.startsWith('--'));
  const lines = fs.readFileSync(path.join(__dirname, '..', 'seeds.txt'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const logPath = path.join(__dirname, '..', 'docs', 'seed-run.json');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : {};
  for (const line of lines) {
    if (only && !line.includes(only)) continue;
    if (onlyFailed && log[line] && log[line].pass) continue;
    const t0 = Date.now();
    let entry;
    try {
      const r = await create(parseRequest(line));
      entry = { pass: r.pass, attempts: r.attempts, blocked: r.result && r.result.blocked || null, problems: r.pass ? [] : (r.result.problems || []) };
    } catch (e) {
      entry = { pass: false, attempts: 0, error: e.message };
      console.log('  error: ' + e.message);
    }
    const runs = ((log[line] && log[line].runs) || 0) + 1;
    log[line] = { ...entry, runs, seconds: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString() };
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2) + '\n');
  }
  await closeBrowser();
  const vals = Object.values(log);
  console.log(`\nseed: ${vals.filter(v => v.pass).length}/${vals.length} verified`);
})();
