#!/usr/bin/env node
/**
 * 牛客网爬取 Worker — 被 text-crawl-parallel.js 调度
 *
 * 参数：
 *   --worker <N>       Worker 编号
 *   --tasks <JSON>     [{companyId, keywords, limit}]
 */
const { chromium } = require('playwright');
const os = require('os');
const { shouldSkipByTitle, shouldSkipByContent, matchesCompany, saveRawMd, urlExists, loadManifest, isUrlGloballyCrawled, sleep } = require('./crawl-common');

const PROFILE_DIR_DEFAULT = require('path').join(os.homedir(), '.agent-browser-profile');

/**
 * 在搜索结果页收集所有帖子链接（标题+href），通过点击"下一页"翻页
 * 牛客搜索结果是传统分页模式，不是滚动加载
 *
 * 牛客分页 DOM 结构（实测 2026-02）：
 *   div.search-agination.is-background
 *     button.btn-prev.is-disable   ← 上一页（第1页时 disabled + class is-disable）
 *     ul.pager                     ← 页码列表 li*10
 *     button.btn-prev              ← 下一页（注意：class 也叫 btn-prev，是牛客的 bug）
 */
async function collectSearchLinks(page, maxLinks = 500) {
  const collected = [];
  const seenUrls = new Set();

  for (let pageNum = 1; pageNum <= 25 && collected.length < maxLinks; pageNum++) {
    // 等待内容加载
    await page.waitForSelector('a[href*="/discuss/"], a[href*="/feed/"]', { timeout: 8000 }).catch(() => {});

    // 提取当前页的链接
    const items = await page.evaluate(() => {
      return [...document.querySelectorAll('a[href*="/discuss/"], a[href*="/feed/main/detail/"]')]
        .filter(a => /\/(discuss\/\d+|feed\/main\/detail\/)/.test(a.href))
        .map(a => ({
          url: a.href.split('?')[0],
          title: a.textContent.trim() || '',
        }));
    });

    let newCount = 0;
    for (const item of items) {
      if (!seenUrls.has(item.url) && item.title.length > 2) {
        seenUrls.add(item.url);
        collected.push(item);
        newCount++;
      }
    }

    console.log(`    📄 第${pageNum}页: ${newCount} 个新链接 (累计 ${collected.length})`);

    // 当前页没有新链接，说明到底了
    if (newCount === 0 && pageNum > 1) break;

    // 已经够了
    if (collected.length >= maxLinks) break;

    // 找到分页容器，点击"下一页"
    // 牛客的下一页按钮是 .search-agination 内的第二个 button（两个都叫 btn-prev）
    const nextBtn = await page.evaluate(() => {
      const container = document.querySelector('.search-agination, .el-pagination');
      if (!container) return { found: false, reason: 'no-container' };
      const buttons = container.querySelectorAll('button');
      if (buttons.length < 2) return { found: false, reason: 'not-enough-buttons', count: buttons.length };
      const nextButton = buttons[buttons.length - 1]; // 最后一个 button 就是下一页
      const isDisabled = nextButton.disabled || nextButton.classList.contains('is-disable') || nextButton.classList.contains('disabled');
      return { found: true, isDisabled };
    });

    if (!nextBtn.found) {
      console.log(`    ⚠️ 未找到分页按钮 (${nextBtn.reason})`);
      break;
    }
    if (nextBtn.isDisabled) {
      console.log(`    📄 已到最后一页`);
      break;
    }

    // 点击下一页按钮（容器内最后一个 button）
    await page.evaluate(() => {
      const container = document.querySelector('.search-agination, .el-pagination');
      const buttons = container.querySelectorAll('button');
      buttons[buttons.length - 1].click();
    });

    await sleep(2000 + Math.random() * 1000);
  }

  return collected;
}



async function crawlOneCompany(page, task) {
  const { companyId, keywords, limit } = task;
  let saved = 0;
  const visitedUrls = new Set(); // 本轮已访问过的 URL（跨关键词去重）

  for (const keyword of keywords) {
    if (saved >= limit) break;
    console.log(`\n🔍 搜索: ${keyword} (${companyId})`);

    const searchUrl = `https://www.nowcoder.com/search?type=post&query=${encodeURIComponent(keyword)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);

    // 点击"面经"标签
    const mjBtn = page.locator('button', { hasText: '面经' });
    if (await mjBtn.count() > 0) {
      await mjBtn.first().click();
      await sleep(1500);
    }

    // 点击"最新"排序
    const latestBtn = page.locator('label:has-text("最新"), span:has-text("最新")');
    if (await latestBtn.count() > 0) {
      await latestBtn.first().click();
      await sleep(1500);
    }

    // 收集搜索结果链接（点击翻页）
    const searchItems = await collectSearchLinks(page);
    console.log(`  📋 收集到 ${searchItems.length} 个链接`);

    // 过滤已抓过的和已访问的（manifest 单公司去重 + DB crawled_urls 全局去重）
    const manifest = loadManifest(companyId);
    const newItems = searchItems.filter(item =>
      !urlExists(manifest, item.url) && !visitedUrls.has(item.url) && !isUrlGloballyCrawled(item.url)
    );
    console.log(`  🆕 ${newItems.length} 个新链接`);

    for (const item of newItems) {
      if (saved >= limit) break;
      visitedUrls.add(item.url);

      // 搜索结果页标题预过滤（如果标题够长）
      if (item.title && item.title.length > 4) {
        const preFilter = shouldSkipByTitle(item.title);
        if (preFilter.skip) {
          console.log(`  ⏭️ [${preFilter.reason}] ${item.title.substring(0, 60)}`);
          continue;
        }
      }

      try {
        await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(1000 + Math.random() * 1000);

        const data = await page.evaluate(() => {
          // 标题：优先用 discuss 专用选择器
          const titleSelectors = [
            '.discuss-title', 'h1.post-title', '.post-detail h1',
            '.nc-post-detail h1', 'h1',
          ];
          let title = '';
          for (const sel of titleSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.trim().length > 4) {
              title = el.textContent.trim(); break;
            }
          }
          if (!title) title = document.title.replace(/_牛客网.*$/, '').trim();

          // 正文
          const contentSelectors = [
            '.nc-post-content', '.post-content', '[class*="rich-text"]',
            '.discuss-main', 'article', '.markdown-body',
          ];
          let content = '';
          for (const sel of contentSelectors) {
            const el = document.querySelector(sel);
            if (el && el.innerText.trim().length > 100) { content = el.innerText.trim(); break; }
          }
          if (!content || content.length < 100) {
            const divs = [...document.querySelectorAll('div')]
              .filter(d => d.children.length < 3 && d.innerText.length > 200);
            if (divs.length > 0) {
              divs.sort((a, b) => b.innerText.length - a.innerText.length);
              content = divs[0].innerText.trim();
            }
          }

          // 发布时间
          const timeEl = document.querySelector('time, .post-time, .discuss-time, [class*="create-time"]');
          const publishedAt = timeEl ? timeEl.getAttribute('datetime') || timeEl.textContent.trim() : '';
          return { title, content, publishedAt };
        });

        if (!data.content || data.content.length < 50) {
          console.log(`  ⏭️ 内容太短: ${(data.title || '').substring(0, 40)}`);
          continue;
        }

        const titleFilter = shouldSkipByTitle(data.title);
        if (titleFilter.skip) {
          console.log(`  ⏭️ [${titleFilter.reason}] ${data.title.substring(0, 60)}`);
          continue;
        }

        const contentFilter = shouldSkipByContent(data.title, data.content.substring(0, 500));
        if (contentFilter.skip) {
          console.log(`  ⏭️ [${contentFilter.reason}] ${data.title.substring(0, 40)}`);
          continue;
        }

        // 公司匹配：标题或正文前200字必须包含目标公司名
        if (!matchesCompany(data.title, data.content.substring(0, 500), companyId)) {
          console.log(`  ⏭️ [非目标公司] ${data.title.substring(0, 60)}`);
          continue;
        }

        const filePath = saveRawMd(companyId, {
          title: data.title,
          url: item.url,
          content: data.content,
          source: '牛客网',
          publishedAt: data.publishedAt || new Date().toISOString().slice(0, 10),
        });

        if (filePath) {
          saved++;
          console.log(`  ✅ [${saved}/${limit}] ${data.title.substring(0, 50)}`);
        } else {
          console.log(`  ⏭️ 已存在: ${data.title.substring(0, 40)}`);
        }
      } catch (e) {
        console.log(`  ❌ 抓取失败: ${item.url} - ${e.message.substring(0, 80)}`);
      }
    }
  }

  console.log(`\n✅ ${companyId}: 保存 ${saved} 条`);
  return { companyId, saved };
}

// ─── 主入口 ───

async function main() {
  const args = process.argv.slice(2);
  let workerIdx = 0;
  let tasks = [];
  let profileDir = PROFILE_DIR_DEFAULT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--worker') workerIdx = parseInt(args[++i]);
    else if (args[i] === '--profile') profileDir = args[++i];
    else if (args[i] === '--tasks') tasks = JSON.parse(args[++i]);
  }

  if (tasks.length === 0) { console.error('❌ 无任务'); process.exit(1); }

  console.log(`🏃 Nowcoder Worker ${workerIdx} 启动，${tasks.length} 个公司`);

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  const COMPANY_TIMEOUT = 4 * 60 * 1000; // 单公司超时 4 分钟

  const results = [];
  for (let i = 0; i < tasks.length; i++) {
    if (i > 0) {
      const gap = 3000 + Math.random() * 5000;
      console.log(`\n⏳ 间隔 ${(gap / 1000).toFixed(1)}s...`);
      await sleep(gap);
    }
    try {
      const result = await Promise.race([
        crawlOneCompany(page, tasks[i]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`超时(${COMPANY_TIMEOUT / 1000}s)`)), COMPANY_TIMEOUT)
        ),
      ]);
      results.push(result);
    } catch (e) {
      console.error(`❌ ${tasks[i].companyId} 失败: ${e.message}`);
      results.push({ companyId: tasks[i].companyId, saved: 0, error: e.message });
    }
  }

  await ctx.close();
  console.log(`\n🏁 Nowcoder Worker ${workerIdx} 完成`);
  results.forEach(r => {
    if (r.error) console.log(`  ❌ ${r.companyId}: ${r.error}`);
    else console.log(`  ✅ ${r.companyId}: ${r.saved} 条`);
  });
  process.exit(0);
}

main().catch(e => { console.error('💥', e.message); process.exit(1); });
