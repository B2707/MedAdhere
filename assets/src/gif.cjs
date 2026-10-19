'use strict';
// Renders the README GIFs (chat.gif, dashboard-tour.gif) from chat.html and tour.html.
// Run: NODE_PATH=<dir with playwright> node assets/src/gif.cjs   (needs ffmpeg on PATH)
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const FPS = 15, CHAT_FPS = 25;

function chatStates(end) {
  // chat.html is driven by window.render(t); one state per frame at CHAT_FPS.
  const out = []; for (let i = 0; i < Math.round(end * CHAT_FPS); i++) out.push({ t: i / CHAT_FPS }); return out;
}

function tourStates() {
  const out = [], heights = [1153, 1405, 1152].map(h => h * 1040 / 1440 - 756);
  for (let i = 0; i < 3; i++) {
    const n = 3.0 * FPS;
    for (let f = 0; f < n; f++) { const p = f / (n - 1); out.push({ i, t: 0, y: heights[i] * (p < 0.2 ? 0 : Math.min(1, (p - 0.2) / 0.6)) }); }
    const fade = Math.round(0.5 * FPS);
    for (let f = 1; f <= fade; f++) out.push({ i, t: f / fade, y: heights[i] });
  }
  return out;
}

async function render(browser, html, states, size, gif, width, fps = FPS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medgif-'));
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
  await page.goto('file://' + path.join(__dirname, html));
  await page.waitForTimeout(400);
  let last = null, lastBuf = null;
  for (let i = 0; i < states.length; i++) {
    const key = JSON.stringify(states[i]);
    if (key !== last) { await page.evaluate(s => ('t' in s ? window.render(s.t) : window.setState(s)), states[i]); lastBuf = await page.screenshot({ type: 'png' }); last = key; }
    fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.png`), lastBuf);
  }
  await page.close();
  const out = path.join(__dirname, '..', gif);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(dir, 'f%04d.png'),
    '-vf', `scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    '-loop', '0', out]);
  fs.rmSync(dir, { recursive: true });
  console.log('rendered', gif, (fs.statSync(out).size / 1e6).toFixed(2) + ' MB', states.length + ' frames');
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const probe = await browser.newPage();
  await probe.goto('file://' + path.join(__dirname, 'chat.html'));
  const end = await probe.evaluate(() => window.END);
  await probe.close();
  await render(browser, 'chat.html', chatStates(end), { width: 1240, height: 1000 }, 'chat.gif', 900, CHAT_FPS);
  if (process.argv[2] === 'chat') { await browser.close(); return; }
  await render(browser, 'tour.html', tourStates(), { width: 1100, height: 900 }, 'dashboard-tour.gif', 820);
  await browser.close();
})();
