// Before/after GIF for one patch: captioned frames rendered by Playwright, crossfaded by ffmpeg.
// Usage: node scripts/gif.js <host>/<slug> [out.gif]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const [id, outArg] = process.argv.slice(2);
if (!id) { console.error('usage: node scripts/gif.js <host>/<slug> [out.gif]'); process.exit(2); }
const ROOT = path.resolve(__dirname, '..');
const [host, slug] = id.split('/');
const dir = path.join(ROOT, 'patches', host);
const meta = JSON.parse(fs.readFileSync(path.join(dir, `${slug}.meta.json`), 'utf8'));
const out = outArg || path.join(ROOT, 'docs', `${host}--${slug}.gif`);
const tmp = path.join(ROOT, 'out', 'gif');
fs.mkdirSync(tmp, { recursive: true });

const frame = (img, which) => `<!doctype html><html><body style="margin:0;background:#0e0f11;font-family:'Cascadia Code',Consolas,monospace;color:#e8e6e1;width:1000px">
<div style="padding:14px 20px;display:flex;align-items:center;gap:14px;border-bottom:1px solid #26292f">
  <span style="color:#8b8f98">$</span><span>sitepatch "${meta.host}: ${meta.request.replace(/"/g, '&quot;')}"</span></div>
<div style="position:relative"><img src="data:image/jpeg;base64,${fs.readFileSync(img).toString('base64')}" style="width:1000px;display:block">
<span style="position:absolute;top:14px;right:14px;padding:6px 12px;border-radius:99px;font-weight:700;font-size:15px;${which === 'after'
    ? 'background:#3ecf8e;color:#0e0f11">AFTER · verified ✓' : 'background:#ff5d5d;color:#0e0f11">BEFORE'}</span></div>
<div style="padding:10px 20px;font-size:13px;color:#8b8f98">${which === 'after' ? meta.assertion.slice(0, 2).join(' · ').replace(/</g, '&lt;') : 'live page, logged out, unpatched'}</div>
</body></html>`;

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1000, height: 600 } });
  for (const which of ['before', 'after']) {
    await p.setContent(frame(path.join(dir, `${slug}.${which}.jpg`), which));
    await p.screenshot({ path: path.join(tmp, `${which}.png`), fullPage: true });
  }
  await b.close();
  const [bf, af] = ['before', 'after'].map(w => path.join(tmp, `${w}.png`));
  // hold before 1.6s -> fade 0.5s -> hold after 2.2s -> fade back; 12 fps, shared palette.
  const fc = '[0][1]xfade=transition=fade:duration=0.5:offset=1.6[ab];[ab][2]xfade=transition=fade:duration=0.5:offset=3.8,fps=12,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4';
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-t', '2.1', '-i', bf, '-loop', '1', '-t', '2.7', '-i', af, '-loop', '1', '-t', '1.2', '-i', bf,
    '-filter_complex', fc, '-loop', '0', out]);
  console.log(`${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
})();
