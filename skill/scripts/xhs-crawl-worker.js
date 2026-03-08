#!/usr/bin/env node
/**
 * 小红书抓取 Worker — 被 xhs-crawl-parallel.js 调度
 *
 * 每个 worker 使用独立的浏览器 profile，串行执行分配到的公司任务。
 * 不直接调用，由 parallel 调度器启动。
 *
 * 参数：
 *   --worker <N>       Worker 编号（决定使用哪个 browser profile）
 *   --tasks <JSON>     任务列表 JSON，格式: [{keyword, outDir, companyId, limit}]
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { isCrawledUrl, addCrawledUrl } = require('./db');
const { shouldSkipByTitle, RAW_BASE } = require('./crawl-common');

// browser profile 存放在用户 home 目录，避免硬编码路径
const BROWSER_DATA_BASE = path.join(os.homedir(), '.agent-browser-profile-xhs-data');

// ─── 工具函数 ───

function extractNoteId(url) {
  const match = url.match(/\/explore\/([a-f0-9]+)/);
  return match ? match[1] : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Worker 去重管理（DB-backed） ───

class CrawledTracker {
  constructor(workerIdx) {
    this.workerIdx = workerIdx;
    this.ids = new Set();
    this._currentCompanyId = 'unknown';
  }

  has(noteId) {
    if (this.ids.has(noteId)) return true;
    const fullUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
    if (isCrawledUrl(fullUrl)) {
      this.ids.add(noteId);
      return true;
    }
    return false;
  }

  add(noteId, title) {
    this.ids.add(noteId);
    try {
      const fullUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
      addCrawledUrl(this._currentCompanyId || 'unknown', fullUrl, { source: 'xiaohongshu', title });
    } catch (_) { /* DB 写入失败不影响主流程 */ }
  }

  setCompanyId(companyId) {
    this._currentCompanyId = companyId;
  }

  save() {}
}

// ─── 浏览器 & 截图 ───

function getProfileDir(workerIdx) {
  if (workerIdx === 0) return path.join(BROWSER_DATA_BASE, 'xiaohongshu');
  return path.join(BROWSER_DATA_BASE, `xiaohongshu-w${workerIdx}`);
}

async function launchBrowser(workerIdx) {
  const profileDir = getProfileDir(workerIdx);
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  return ctx;
}

async function screenshotNotePages(page, outDir, prefix) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  await sleep(2000);

  const pageInfo = await page.evaluate(() => {
    const slider = document.querySelector('.xhs-slider-container');
    if (!slider) return null;
    const text = slider.textContent.trim();
    const match = text.match(/(\d+)\s*\/\s*(\d+)/);
    return match ? { current: parseInt(match[1]), total: parseInt(match[2]) } : null;
  });

  const totalPages = pageInfo ? pageInfo.total : 1;
  console.log(`  📄 共 ${totalPages} 页`);

  for (let i = 1; i <= totalPages; i++) {
    const filePath = path.join(outDir, `${prefix}-${i}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    files.push(filePath);
    console.log(`  📸 截图: ${path.basename(filePath)}`);

    if (i < totalPages) {
      for (let retry = 0; retry < 3; retry++) {
        const arrow = await page.$('.arrow-controller.right');
        if (arrow) {
          await arrow.click();
          await sleep(1200);
          const cur = await page.evaluate(() => {
            const s = document.querySelector('.xhs-slider-container');
            if (!s) return 0;
            const m = s.textContent.trim().match(/(\d+)\s*\//);
            return m ? parseInt(m[1]) : 0;
          });
          if (cur === i + 1) break;
          console.log(`  ⚠️ 翻页未生效（当前${cur}，期望${i+1}），重试...`);
          await sleep(800);
        }
      }
    }
  }

  const textContent = await page.evaluate(() => {
    const title = document.querySelector('.note-content .title')?.textContent?.trim() || '';
    const desc = document.querySelector('#detail-desc')?.textContent?.trim() || '';
    const tags = [...document.querySelectorAll('#detail-desc a.tag')].map(a => a.textContent.trim());
    return { title, desc, tags };
  });

  return { files, textContent };
}

async function scrollForMore(page, prevCount, maxRetries = 5) {
  for (let retry = 0; retry < maxRetries; retry++) {
    const isEnd = await page.evaluate(() => {
      const body = document.body.innerText;
      return body.includes('THE END') || body.includes('没有更多了') || body.includes('到底了');
    });
    if (isEnd) {
      console.log('  🏁 搜索结果已到底');
      return -1;
    }

    await page.evaluate(async () => {
      const scrollStep = window.innerHeight * 0.8;
      window.scrollTo({ top: window.scrollY + scrollStep, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, 800 + Math.random() * 400));
    });
    await sleep(2000 + Math.random() * 1500);

    const newCount = await page.evaluate(() => document.querySelectorAll('a.title').length);
    if (newCount > prevCount) {
      console.log(`  📋 滚动加载: ${prevCount} → ${newCount} 条`);
      return newCount;
    }

    await page.evaluate(() => window.scrollBy(0, -300));
    await sleep(800);
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    await sleep(1500 + Math.random() * 1000);

    const retryCount = await page.evaluate(() => document.querySelectorAll('a.title').length);
    if (retryCount > prevCount) return retryCount;
  }
  return prevCount;
}

// ─── 核心抓取逻辑（单个关键词搜索 + 截图） ───

async function crawlOneTask(page, task, tracker) {
  const { keyword, outDir, companyId, limit } = task;
  tracker.setCompanyId(companyId);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n🔍 搜索: ${keyword} (${companyId}, limit=${limit})`);
  await page.goto('https://www.xiaohongshu.com', { waitUntil: 'domcontentloaded' });
  await sleep(3000);

  const searchBox = page.locator('[placeholder*="搜索"]').first();
  await searchBox.click();
  await sleep(500);
  await searchBox.fill(keyword);
  await sleep(300);
  await page.keyboard.press('Enter');
  await sleep(3000);

  const allFiles = [];
  let fetched = 0;
  let processedIdx = 0;
  let noNewContentStreak = 0;
  const MAX_NO_NEW = 8;

  while (fetched < limit) {
    const totalInDom = await page.evaluate(() => document.querySelectorAll('a.title').length);

    if (processedIdx >= totalInDom) {
      const newCount = await scrollForMore(page, totalInDom);
      if (newCount === -1) break;
      if (newCount <= totalInDom) {
        noNewContentStreak++;
        if (noNewContentStreak >= MAX_NO_NEW) break;
        continue;
      }
      noNewContentStreak = 0;
      continue;
    }

    const titleInfo = await page.evaluate((idx) => {
      const el = document.querySelectorAll('a.title')[idx];
      if (!el) return null;
      return { text: el.textContent.trim(), href: el.getAttribute('href') || '' };
    }, processedIdx);

    if (!titleInfo) { processedIdx++; continue; }

    const filterResult = shouldSkipByTitle(titleInfo.text);
    if (filterResult.skip) {
      console.log(`  ⏭️ [${filterResult.reason}] 跳过: ${titleInfo.text}`);
      processedIdx++;
      continue;
    }

    console.log(`\n📖 [${fetched + 1}/${limit}] ${titleInfo.text}`);

    await page.evaluate(({ href, idx }) => {
      const el = href ? document.querySelector(`a.title[href="${href}"]`) : document.querySelectorAll('a.title')[idx];
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, { href: titleInfo.href, idx: processedIdx });
    await sleep(800);

    const urlBefore = page.url();
    await page.evaluate(({ href, idx }) => {
      const el = href ? document.querySelector(`a.title[href="${href}"]`) : document.querySelectorAll('a.title')[idx];
      if (el) el.click();
    }, { href: titleInfo.href, idx: processedIdx });
    await sleep(3000);

    const urlAfter = page.url();
    const isOverlay = (urlAfter === urlBefore);

    let noteUrl;
    if (isOverlay) {
      noteUrl = await page.evaluate(() => {
        const noteLink = document.querySelector('.note-detail-mask a[href*="/explore/"]')
          || document.querySelector('[class*="note"] a[href*="/explore/"]');
        return noteLink ? noteLink.href : window.location.href;
      });
    } else {
      noteUrl = urlAfter;
    }
    const noteId = extractNoteId(noteUrl);
    console.log(`  🔗 ${noteUrl}`);

    if (noteId && tracker.has(noteId)) {
      console.log(`  ⏭️ 已爬过，跳过`);
      if (isOverlay) {
        await page.evaluate(() => {
          const btn = document.querySelector('.close-circle, [class*="close"], .note-detail-mask');
          if (btn) btn.click();
        });
        await sleep(1000);
      } else {
        await page.goBack();
        await sleep(2000);
      }
      processedIdx++;
      continue;
    }

    const prefix = `${companyId}-${String(fetched + 1).padStart(2, '0')}`;
    const { files, textContent } = await screenshotNotePages(page, outDir, prefix);
    allFiles.push({ title: titleInfo.text, url: noteUrl, files, textContent });
    if (noteId) tracker.add(noteId, titleInfo.text);
    fetched++;
    processedIdx++;

    const resultSoFar = allFiles.map(n => ({
      title: n.title, url: n.url,
      screenshots: n.files.map(f => path.basename(f)),
      textContent: n.textContent || null
    }));
    fs.writeFileSync(path.join(outDir, '_result.json'), JSON.stringify(resultSoFar, null, 2));

    if (isOverlay) {
      await page.evaluate(() => {
        const btn = document.querySelector('.close-circle, [class*="close"], .note-detail-mask');
        if (btn) btn.click();
      });
      await sleep(1000 + Math.random() * 500);
    } else {
      await page.goBack();
      await sleep(2000 + Math.random() * 1000);
      await page.waitForSelector('a.title', { timeout: 5000 }).catch(() => {});

      let domAfterBack = await page.evaluate(() => document.querySelectorAll('a.title').length);
      if (domAfterBack < processedIdx) {
        console.log(`  🔄 返回后恢复滚动位置...`);
        let recoveryAttempts = 0;
        while (domAfterBack < processedIdx && recoveryAttempts < 15) {
          await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
          await sleep(1500 + Math.random() * 1000);
          const newDom = await page.evaluate(() => document.querySelectorAll('a.title').length);
          if (newDom === domAfterBack) {
            recoveryAttempts++;
            await page.evaluate(() => window.scrollBy(0, -200));
            await sleep(500);
          } else {
            recoveryAttempts = 0;
          }
          domAfterBack = newDom;
        }
      }
    }

    await page.evaluate((idx) => {
      const el = document.querySelectorAll('a.title')[idx];
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, processedIdx);
    await sleep(500);
  }

  console.log(`\n✅ ${companyId}: 抓取 ${fetched} 条，截图 ${allFiles.reduce((s, n) => s + n.files.length, 0)} 张`);
  return { companyId, fetched, totalScreenshots: allFiles.reduce((s, n) => s + n.files.length, 0) };
}

// ─── 主入口 ───

async function main() {
  const args = process.argv.slice(2);
  let workerIdx = 0;
  let tasks = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--worker') workerIdx = parseInt(args[++i]);
    else if (args[i] === '--tasks') tasks = JSON.parse(args[++i]);
  }

  if (tasks.length === 0) {
    console.error('❌ 无任务');
    process.exit(1);
  }

  console.log(`🏃 Worker ${workerIdx} 启动，${tasks.length} 个任务`);
  const tracker = new CrawledTracker(workerIdx);
  const ctx = await launchBrowser(workerIdx);
  const page = ctx.pages()[0] || await ctx.newPage();

  const results = [];
  for (let i = 0; i < tasks.length; i++) {
    if (i > 0) {
      const gap = 5000 + Math.random() * 10000;
      console.log(`\n⏳ 任务间隔 ${(gap / 1000).toFixed(1)}s...`);
      await sleep(gap);
    }
    try {
      const result = await crawlOneTask(page, tasks[i], tracker);
      results.push(result);
    } catch (e) {
      console.error(`❌ 任务 ${tasks[i].companyId} 失败: ${e.message}`);
      results.push({ companyId: tasks[i].companyId, fetched: 0, error: e.message });
    }
  }

  tracker.save();
  await ctx.close();

  console.log(`\n🏁 Worker ${workerIdx} 完成`);
  results.forEach(r => {
    if (r.error) console.log(`  ❌ ${r.companyId}: ${r.error}`);
    else console.log(`  ✅ ${r.companyId}: ${r.fetched} 条`);
  });

  process.exit(0);
}

main().catch(e => { console.error('💥', e.message); process.exit(1); });
