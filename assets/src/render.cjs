'use strict';
// Renders the README images from the HTML sources in this folder.
// Run: NODE_PATH=<dir with playwright> node assets/src/render.cjs
const { chromium } = require('playwright');
const path = require('path');

const jobs = [
  { html: 'architecture.html', out: '../architecture.jpg', width: 1600, height: 1010 },
  { html: 'phones.html', out: '../phones.jpg', width: 1200, height: 1080 },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  for (const job of jobs) {
    const page = await browser.newPage({
      viewport: { width: job.width, height: job.height },
      deviceScaleFactor: 2,
    });
    await page.goto('file://' + path.join(__dirname, job.html));
    await Promise.all(page.frames().map(frame => frame.evaluate(async () => {
    await Promise.all([document.fonts.load('400 16px "Public Sans"'), document.fonts.load('400 12px "IBM Plex Mono"')]);
    await document.fonts.ready;
  })));
    await page.screenshot({ path: path.join(__dirname, job.out), type: 'jpeg', quality: 90 });
    await page.close();
    console.log('rendered', job.out);
  }
  await browser.close();
})();
