#!/usr/bin/env node
// sitepatch "<domain>: <request>"   generate + verify + save a patch
// sitepatch retest [filter] [--no-repair]   re-verify every patch, repair broken ones
// sitepatch registry                 rebuild the static registry page
const { parseRequest } = require('../src/request');

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log('usage:\n  sitepatch "<domain>: <request>"\n  sitepatch retest [filter] [--no-repair]\n  sitepatch registry');
    return 0;
  }
  const { closeBrowser } = require('../src/browser');
  try {
    if (cmd === 'registry') {
      const out = require('../src/registry').build();
      console.log(`registry written: ${out}`);
      return 0;
    }
    if (cmd === 'retest') {
      const { retest } = require('../src/patch');
      const rows = await retest({ repair: !rest.includes('--no-repair'), only: rest.find(a => !a.startsWith('--')) });
      require('../src/registry').build();
      const tally = rows.reduce((t, r) => ((t[r.outcome] = (t[r.outcome] || 0) + 1), t), {});
      console.log(`\nretest: ${rows.length} patches — ${JSON.stringify(tally)}`);
      return rows.some(r => r.outcome === 'fail') ? 1 : 0;
    }
    const req = parseRequest([cmd, ...rest].join(' '));
    const { create } = require('../src/patch');
    const r = await create(req, { saveFailures: rest.includes('--save-failures') });
    if (r.pass) {
      console.log(`\nverified in ${r.attempts} attempt(s): patches/${r.meta.host}/${r.meta.slug}.user.js`);
      require('../src/registry').build();
      return 0;
    }
    console.log(`\nFAILED after ${r.attempts} attempt(s): ${(r.result.problems || []).join('; ')}`);
    return 1;
  } finally {
    await closeBrowser();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error('sitepatch: ' + e.message); process.exit(2); });
}
module.exports = { main };
