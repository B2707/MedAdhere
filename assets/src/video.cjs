'use strict';
// Renders the launch video from launch.html: ../launch.mp4 (1920x1080, 30 fps) and ../launch.gif (README).
// Run: NODE_PATH=<dir with playwright> node assets/src/video.cjs   (needs ffmpeg on PATH)
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const FPS = 30;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medvid-'));
  const browser = await chromium.launch({ headless: true, args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.join(__dirname, 'launch.html'));
  await Promise.all(page.frames().map(frame => frame.evaluate(async () => {
    await Promise.all([document.fonts.load('400 16px "Public Sans"'), document.fonts.load('400 12px "IBM Plex Mono"')]);
    await document.fonts.ready;
  })));
  const end = await page.evaluate(() => window.END);
  const n = Math.round(end * FPS);
  for (let i = 0; i < n; i++) {
    await page.evaluate(t => window.render(t), i / FPS);
    await page.screenshot({ path: path.join(dir, `f${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 95 });
  }
  await browser.close();
  const mp4 = path.join(__dirname, '..', 'launch.mp4'), gif = path.join(__dirname, '..', 'launch.gif');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, 'f%05d.jpg'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf',
    'fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    '-loop', '0', gif]);
  fs.rmSync(dir, { recursive: true });
  for (const f of [mp4, gif]) console.log('rendered', path.basename(f), (fs.statSync(f).size / 1e6).toFixed(2) + ' MB');
})();
