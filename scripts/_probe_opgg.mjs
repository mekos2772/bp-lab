import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
const gql = [];
page.on('request', r => { const u = r.url(); if (/api|graphql/.test(u)) gql.push(u); });
await page.goto('https://esports.op.gg/matches/32655', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);
const info = await page.evaluate(() => {
  const imgs = Array.from(document.querySelectorAll('img')).map(i => i.src);
  const champImgs = imgs.filter(s => /champion|champ|ddragon|cdn\/.*\/champion/i.test(s));
  const text = document.body.innerText.replace(/\s+/g, ' ').slice(0, 700);
  return { title: document.title, nImgs: imgs.length, champImgs: champImgs.slice(0, 12), text };
});
console.log(JSON.stringify({ title: info.title, nImgs: info.nImgs, champ: info.champImgs, text: info.text.slice(0, 400) }, null, 1));
console.log('API', JSON.stringify(gql.slice(0, 8), null, 1).slice(0, 900));
await browser.close();
