#!/usr/bin/env node
/**
 * CSDN 搜索抓取 Worker — 通过 CSDN 搜索 API 发现面经文章，HTTP 抓取正文
 * 
 * 用法：
 *   node csdn-crawl-worker.js --company bilibili --limit 10
 *   node csdn-crawl-worker.js --company dewu,kuaishou --limit 5
 *   node csdn-crawl-worker.js --all --limit 5
 *   node csdn-crawl-worker.js --dry  # 只搜索不抓取
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const path = require('path');
const fs = require('fs');

const { shouldSkipByTitle, shouldSkipByContent, matchesCompany, saveRawMd, isUrlGloballyCrawled, loadProfile, sleep } = require('./crawl-common.js');

// INTEL_DIR 不再需要，路径由 crawl-common 统一管理

// ─── HTTP 工具 ───

function httpGet(url, opts = {}, _redir = 0) {
  return new Promise((resolve, reject) => {
    if (_redir >= 5) return reject(new Error('too many redirects'));
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        ...opts.headers,
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redir = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return httpGet(redir, opts, _redir + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      const timer = setTimeout(() => { res.destroy(); reject(new Error('response timeout')); }, 15000);
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8'), url: res.url || url });
      });
      res.on('error', e => { clearTimeout(timer); reject(e); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── HTML → Markdown ───

function htmlToMarkdown(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<h([1-6])[^>]*>/gi, (_, level) => '#'.repeat(parseInt(level)) + ' ')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => '\n```\n' + code.replace(/<[^>]+>/g, '') + '\n```\n')
    .replace(/<[^>]+>/g, '')
    // HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── CSDN 搜索 API ───

async function searchCSDN(keyword, page = 1) {
  try {
    const url = `https://so.csdn.net/api/v3/search?q=${encodeURIComponent(keyword)}&t=blog&p=${page}&s=0`;
    const res = await httpGet(url, { headers: { 'Accept': 'application/json' } });
    if (res.status !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.result_vos || []).map(v => ({
      title: (v.title || '').replace(/<[^>]+>/g, ''),
      url: (v.url || '').split('?')[0], // strip tracking params
      desc: (v.description || '').replace(/<[^>]+>/g, ''),
    })).filter(a => a.url && a.url.includes('blog.csdn.net'));
  } catch {
    return [];
  }
}


// ─── 文章抓取 ───

async function fetchCSDNArticle(url) {
  try {
    const res = await httpGet(url);
    if (res.status !== 200) return null;

    // 提取标题
    const titleMatch = res.body.match(/<h1[^>]*class="title-article"[^>]*>([^<]+)<\/h1>/i) ||
                       res.body.match(/<title[^>]*>([^<]+)<\/title>/i);
    let title = titleMatch ? titleMatch[1].replace(/[-_|–—].*$/, '').trim() : null;
    if (!title) return null;
    // 清理 HTML entities in title
    title = title.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
                 .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
                 .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

    // 提取正文（多种选择器）
    let contentHtml = '';
    const selectors = [
      /id="content_views"[^>]*>([\s\S]*?)<\/div>\s*(?:<div class="hide-article|<\/article)/i,
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /class="markdown_views[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /class="htmledit_views"[^>]*>([\s\S]*?)<\/div>/i,
    ];
    for (const sel of selectors) {
      const m = res.body.match(sel);
      if (m && m[1].length > 200) {
        contentHtml = m[1];
        break;
      }
    }
    if (!contentHtml) return null;

    const content = htmlToMarkdown(contentHtml);
    if (content.length < 200) return null;

    // 提取发布时间
    const timeMatch = res.body.match(/class="time"[^>]*>(\d{4}-\d{2}-\d{2})/i) ||
                      res.body.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/i);
    const publishedAt = timeMatch ? timeMatch[1] : null;

    return { title, content, url, publishedAt };
  } catch {
    return null;
  }
}

// ─── 主逻辑 ───

async function crawlForCompany(companyId, companyConfig, limit, dryRun) {
  const name = companyConfig.name;

  // 构建搜索关键词
  const keywords = [];
  const seen = new Set();
  const addKw = (kw) => { if (!seen.has(kw)) { seen.add(kw); keywords.push(kw); } };

  // 用 config 的 searchKeywords
  if (companyConfig.searchKeywords) {
    companyConfig.searchKeywords.forEach(addKw);
  }
  // 补充变体
  addKw(`${name} Java 社招 凉经`);
  addKw(`${name} 后端 一面 二面 面经`);

  // 每个关键词搜3页（每页30条），去重后应该够
  const maxPages = 3;
  const allArticles = new Map(); // url -> {title, url, desc}

  console.log(`\n🔍 [${name}] CSDN搜索中... (${keywords.length} 组关键词)`);

  for (let ki = 0; ki < keywords.length; ki++) {
    const kw = keywords[ki];
    let kwFound = 0;
    for (let page = 1; page <= maxPages; page++) {
      const results = await searchCSDN(kw, page);
      if (results.length === 0) break;
      for (const r of results) {
        if (!allArticles.has(r.url)) {
          allArticles.set(r.url, r);
          kwFound++;
        }
      }
      await sleep(500 + Math.random() * 500);
    }
    process.stdout.write(`  🔎 [${ki + 1}/${keywords.length}] "${kw}" → +${kwFound} (总计 ${allArticles.size})\n`);
    await sleep(300 + Math.random() * 300);
  }

  console.log(`  📎 CSDN链接: ${allArticles.size} 个`);

  if (dryRun) {
    const urls = [...allArticles.values()];
    for (const a of urls.slice(0, 10)) console.log(`    ${a.title.substring(0, 60)}`);
    if (urls.length > 10) console.log(`    ... 还有 ${urls.length - 10} 个`);
    return { company: companyId, found: allArticles.size, saved: 0 };
  }

  let saved = 0;
  let checked = 0;
  const skippedReasons = {};
  const skip = (reason) => { skippedReasons[reason] = (skippedReasons[reason] || 0) + 1; };

  for (const [url, meta] of allArticles) {
    if (saved >= limit) break;
    checked++;

    // 全局去重
    if (isUrlGloballyCrawled(url)) { skip('global_duplicate'); continue; }

    // 标题预过滤（用搜索结果的标题）
    const titleCheck = shouldSkipByTitle(meta.title);
    if (titleCheck.skip) {
      console.log(`  ⏭️ [标题] ${meta.title.substring(0, 50)} → ${titleCheck.reason}`);
      skip(titleCheck.reason);
      continue;
    }

    // 抓取正文
    const article = await fetchCSDNArticle(url);
    if (!article) { skip('fetch_failed'); continue; }

    // 内容过滤
    const contentCheck = shouldSkipByContent(article.title, article.content.substring(0, 500));
    if (contentCheck.skip) {
      console.log(`  ⏭️ [内容] ${article.title.substring(0, 50)} → ${contentCheck.reason}`);
      skip(contentCheck.reason);
      continue;
    }

    // 公司匹配
    if (!matchesCompany(article.title, article.content.substring(0, 500), companyId)) {
      skip('company_mismatch');
      continue;
    }

    // 保存
    const result = saveRawMd(companyId, {
      title: article.title,
      url,
      content: article.content,
      source: 'csdn',
      publishedAt: article.publishedAt,
    });

    if (result) {
      saved++;
      console.log(`  ✅ [${saved}/${limit}] ${article.title.substring(0, 60)}`);
    } else {
      skip('duplicate');
    }

    await sleep(800 + Math.random() * 400);
  }

  console.log(`  📊 [${name}] 检查 ${checked}/${allArticles.size} 篇，保存 ${saved} 篇`);
  if (Object.keys(skippedReasons).length > 0) {
    console.log(`  📋 跳过原因: ${JSON.stringify(skippedReasons)}`);
  }
  return { company: companyId, found: allArticles.size, checked, saved };
}

async function main() {
  const args = process.argv.slice(2);
  let companyFilter = null;
  let limit = 5;
  let allCompanies = false;
  let dryRun = false;
  let tasksFromDispatcher = null; // --tasks JSON from text-crawl-parallel.js

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--company' || args[i] === '--companies') companyFilter = args[++i].split(',');
    else if (args[i] === '--all') allCompanies = true;
    else if (args[i] === '--limit') limit = parseInt(args[++i]);
    else if (args[i] === '--dry') dryRun = true;
    else if (args[i] === '--tasks') tasksFromDispatcher = JSON.parse(args[++i]);
    else if (args[i] === '--worker') i++; // ignore worker index
    else if (args[i] === '--profile') i++; // CSDN doesn't need browser profile
  }

  // --tasks mode: dispatched by text-crawl-parallel.js
  if (tasksFromDispatcher) {
    const { loadProfile } = require('./crawl-common.js');
    const profile = loadProfile();
    const companyMap = Object.fromEntries((profile?.companies || []).map(c => [c.id, c]));

    console.log(`\n${'='.repeat(50)}`);
    console.log(`📰 CSDN Worker (dispatched) — ${tasksFromDispatcher.length} 个公司`);
    console.log(`${'='.repeat(50)}`);

    const results = [];
    for (const task of tasksFromDispatcher) {
      const companyConfig = companyMap[task.companyId] || { id: task.companyId, name: task.companyId, searchKeywords: task.keywords };
      // merge dispatcher keywords into companyConfig
      if (task.keywords) companyConfig.searchKeywords = [...new Set([...(companyConfig.searchKeywords || []), ...task.keywords])];
      const r = await crawlForCompany(task.companyId, companyConfig, task.limit || limit, dryRun);
      results.push(r);
      await sleep(2000 + Math.random() * 1000);
    }

    const totalSaved = results.reduce((s, x) => s + x.saved, 0);
    console.log(`\n📊 CSDN 完成，总计保存: ${totalSaved} 篇`);
    return;
  }

  if (!allCompanies && !companyFilter) {
    console.log(`CSDN 搜索抓取 Worker
用法：
  node csdn-crawl-worker.js --company bilibili --limit 10
  node csdn-crawl-worker.js --all --limit 5
  node csdn-crawl-worker.js --dry`);
    process.exit(0);
  }

  const { loadProfile } = require('./crawl-common.js');
  const profile = loadProfile();
  let companies = (profile?.companies || []).filter(c => c.id !== 'xiaohongshu');
  if (companyFilter) {
    companies = companies.filter(c => companyFilter.includes(c.id));
  }

  const DATA_DIR = require('./crawl-common.js').DATA_DIR;

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📰 CSDN 搜索抓取 Worker`);
  console.log(`   公司: ${companies.map(c => c.name).join(', ')}`);
  console.log(`   每公司限制: ${limit}`);
  console.log(`   模式: ${dryRun ? 'DRY RUN' : '正式抓取'}`);
  console.log(`${'='.repeat(50)}`);

  const results = [];
  for (const c of companies) {
    const r = await crawlForCompany(c.id, c, limit, dryRun);
    results.push(r);
    // 增量保存结果
    const outputPath = path.join(DATA_DIR, '.csdn-crawl-result.json');
    const totalSaved = results.reduce((s, x) => s + x.saved, 0);
    fs.writeFileSync(outputPath, JSON.stringify({ results, totalSaved, timestamp: new Date().toISOString(), status: 'in-progress' }, null, 2));
    await sleep(2000 + Math.random() * 1000);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 汇总：`);
  let totalSaved = 0;
  for (const r of results) {
    const icon = r.saved > 0 ? '✅' : '⚪';
    console.log(`   ${icon} ${r.company}: 发现 ${r.found} → 保存 ${r.saved}`);
    totalSaved += r.saved;
  }
  console.log(`   总计保存: ${totalSaved} 篇`);
  console.log(`${'='.repeat(50)}\n`);

  // 最终结果
  const outputPath = path.join(DATA_DIR, '.csdn-crawl-result.json');
  fs.writeFileSync(outputPath, JSON.stringify({ results, totalSaved, timestamp: new Date().toISOString(), status: 'done' }, null, 2));
}

main().catch(e => { console.error('💥', e.message); process.exit(1); });
