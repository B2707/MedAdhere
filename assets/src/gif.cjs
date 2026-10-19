'use strict';
// Renders chat.gif and chat.mp4 from chat.html, plus dashboard-tour.gif from tour.html.
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

async function render(browser, html, states, size, gif, width, fps = FPS, deviceScaleFactor = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medgif-'));
  const page = await browser.newPage({ viewport: size, deviceScaleFactor });
  await page.goto('file://' + path.join(__dirname, html));
  await Promise.all(page.frames().map(frame => frame.evaluate(async () => {
    await Promise.all([document.fonts.load('400 16px "Public Sans"'), document.fonts.load('400 12px "IBM Plex Mono"')]);
    await document.fonts.ready;
  })));
  let last = null, lastBuf = null, lastRendered = null;
  for (let i = 0; i < states.length; i++) {
    const key = JSON.stringify(states[i]);
    if (key !== last) {
      const rendered = await page.evaluate(s => ('i' in s ? window.setState(s) : window.render(s.t)), states[i]);
      const renderedKey = typeof rendered === 'string' ? rendered : key;
      if (renderedKey !== lastRendered) lastBuf = await page.screenshot({ type: 'png' });
      lastRendered = renderedKey; last = key;
    }
    fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.png`), lastBuf);
  }
  await page.close();
  const out = path.join(__dirname, '..', gif);
  const gifScale = html === 'chat.html' ? 1500 : width;
  const sampling = html === 'chat.html' ? "select='if(lt(t,21.6),1,not(mod(n,2)))'," : '';
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(dir, 'f%04d.png'),
    '-vf', `${sampling}scale=${gifScale}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    '-fps_mode', 'vfr', '-loop', '0', out]);
  if (html === 'chat.html') {
    const mp4 = out.replace(/\.gif$/, '.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(dir, 'f%04d.png'),
      '-vf', `scale=${width}:-2:flags=lanczos`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
    console.log('rendered', path.basename(mp4), (fs.statSync(mp4).size / 1e6).toFixed(2) + ' MB');
  }
  fs.rmSync(dir, { recursive: true });
  console.log('rendered', gif, (fs.statSync(out).size / 1e6).toFixed(2) + ' MB', states.length + ' frames');
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--allow-file-access-from-files'] });
  const probe = await browser.newPage();
  await probe.goto('file://' + path.join(__dirname, 'chat.html'));
  const end = await probe.evaluate(() => window.END);
  await probe.close();
  await render(browser, 'chat.html', chatStates(end), { width: 2170, height: 1000 }, 'chat.gif', 1800, CHAT_FPS, 1);
  if (process.argv[2] === 'chat') { await browser.close(); return; }
  await render(browser, 'tour.html', tourStates(), { width: 1100, height: 900 }, 'dashboard-tour.gif', 820);
  await browser.close();
})();
