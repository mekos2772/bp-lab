#!/usr/bin/env node
/**
 * 实时比赛轮询器（lolesports 同源接口，浏览器上下文）
 *
 * 做法：用无头 Chrome 打开 lolesports.com，借用页面自身的同源 GraphQL
 * (lolesports.com/api/gql) 拉「进行中 / 即将开始」的比赛，写 data/live_matches.json/.js。
 *
 * 每 15 秒一轮；连续失败自动退避；进程常驻（后台 job）。
 *
 * 用法：node scripts/live_poller.mjs [intervalMs]
 */
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { execFile } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_JSON = ROOT + 'data/live_matches.json';
const OUT_JS = ROOT + 'data/live_matches.js';
const INTERVAL = Number(process.argv[2] || 15000);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 每 30 分钟刷新一次 OP.GG 结果/赛程（队名与比分）
function refreshResults() {
  execFile('python3', [ROOT + 'scripts/fetch_esports_results.py'], { timeout: 240000 }, (err) => {
    if (err) console.error('results refresh failed', String(err).slice(0, 120));
    else console.log('results refreshed at', new Date().toISOString());
  });
}
refreshResults();
setInterval(refreshResults, 30 * 60 * 1000);

function writeAtomic(payload) {
  mkdirSync(ROOT + 'data', { recursive: true });
  const doc = { meta: { source: 'lolesports.com/api/gql (same-origin)', fetchedAt: new Date().toISOString() }, ...payload };
  const tmp = OUT_JSON + '.tmp';
  writeFileSync(tmp, JSON.stringify(doc, null, 1));
  renameSync(tmp, OUT_JSON);
  writeFileSync(OUT_JS, 'window.BP_LIVE = ' + JSON.stringify(doc) + ';\n');
}

async function grab(page) {
  return await page.evaluate(async (urlsIn) => {
    const perf = performance.getEntriesByType('resource').map(e => e.name);
    const urls = [...new Set([...(urlsIn || []), ...perf])].filter(u => u.includes('/api/gql') && u.includes('homeEvents'));
    const seen = new Set();
    const live = [], upcoming = [], recent = [];
    for (const u of urls.slice(-8)) {
      try {
        const j = await (await fetch(u)).json();
        for (const e of (j?.data?.esports?.events || [])) {
          const k = e.id + '|' + e.state;
          if (seen.has(k)) continue;
          seen.add(k);
          if (e.state === 'inProgress') live.push(e);
          else if (e.state === 'unstarted') upcoming.push(e);
          else if (e.state === 'completed') recent.push(e);
        }
      } catch { /* 单个查询失败不影响其他 */ }
    }
    return { live, upcoming, recent };
  }, gqlUrls.slice(-12));
}

function normEvent(e) {
  const teams = (e.match?.teams || []).map(t => ({ name: t.name, code: t.code, wins: t.result?.gameWins ?? null }));
  const games = (e.match?.games || []).map(g => ({ id: g.id, number: g.number, state: g.state }));
  return {
    id: e.id,
    league: e.league?.name,
    leagueSlug: e.league?.slug,
    state: e.state,
    startTime: e.startTime,
    blockName: e.blockName || null,
    teams,
    games,
    matchId: e.match?.id || null,
    bp: null, // 由适配器补充；当前环境 livestats 不可达
  };
}

let browser = null;
let page = null;
let launchedAt = 0;
let gqlUrls = [];

async function ensurePage() {
  const stale = !browser || !browser.isConnected() || !page || page.isClosed() || (Date.now() - launchedAt > 10 * 60 * 1000);
  if (!stale) return;
  if (browser && browser.isConnected()) await browser.close().catch(() => {});
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage();
  gqlUrls = [];
  page.on('request', r => {
    const u = r.url();
    if (u.includes('/api/gql') && u.includes('homeEvents')) gqlUrls.push(u);
  });
  await page.goto('https://lolesports.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  launchedAt = Date.now();
}

let fails = 0;
let lastOk = null;
while (true) {
  try {
    await ensurePage();
    const { live, upcoming, recent } = await grab(page);
    const payload = {
      ok: true,
      live: (live || []).map(normEvent),
      upcoming: (upcoming || []).map(normEvent).slice(0, 12),
      recent: (recent || []).slice(-6).map(normEvent),
    };
    writeAtomic(payload);
    lastOk = new Date().toISOString();
    fails = 0;
    console.log(JSON.stringify({ at: lastOk, live: payload.live.length, upcoming: payload.upcoming.length, recent: payload.recent.length }));
    if (!live && !upcoming) {
      // 页面资源列表可能变化，重新载入一次
      await page.goto('https://lolesports.com/schedule', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
  } catch (err) {
    fails += 1;
    console.error('poll failed', fails, String(err).slice(0, 160));
    try { if (browser) await browser.close(); } catch {}
    browser = null; page = null;
  }
  await sleep(Math.min(INTERVAL * Math.max(1, fails), 120000));
}
