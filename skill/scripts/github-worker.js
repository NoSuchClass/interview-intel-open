#!/usr/bin/env node
/**
 * GitHub 面经仓库爬取 Worker
 *
 * 双策略：
 *   1. Code Search API — 按公司名+面经搜索 markdown 文件
 *   2. 已知面经仓库目录遍历 — 直接拉取 md 文件，按内容匹配公司
 *
 * 用法：
 *   node github-worker.js --worker 0 --tasks '[{"companyId":"pdd","keywords":["拼多多"],"limit":15}]'
 *
 * 环境变量：
 *   GITHUB_TOKEN  推荐设置，Search API 必须认证，Contents API 限额从 60→5000/h
 */
const { shouldSkipByTitle, shouldSkipByContent, matchesCompany, saveRawMd, loadManifest, urlExists, isUrlGloballyCrawled, loadConfig, sleep } = require('./crawl-common');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

// ─── GitHub API ───

async function githubFetch(url) {
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'interview-intel-crawler',
  };
  if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const remaining = resp.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const reset = new Date(parseInt(resp.headers.get('x-ratelimit-reset')) * 1000);
      throw new Error(`API限额用尽，重置: ${reset.toLocaleTimeString()}`);
    }
    throw new Error(`${resp.status}: ${resp.statusText}`);
  }
  return resp.json();
}

/**
 * 通过 Contents API 下载文件内容（避免 raw.githubusercontent.com 被墙）
 * url 格式: https://api.github.com/repos/{owner}/{repo}/contents/{path}
 * 返回 base64 解码后的文本
 */
async function downloadViaContentsApi(repo, path) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const data = await githubFetch(url);
  if (data.encoding === 'base64' && data.content) {
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }
  // 如果文件太大，API 会返回 download_url，尝试直接下载
  if (data.download_url) {
    const headers = { 'User-Agent': 'interview-intel-crawler' };
    if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    const resp = await fetch(data.download_url, { headers });
    if (!resp.ok) throw new Error(`下载失败 ${resp.status}`);
    return resp.text();
  }
  throw new Error('无法获取文件内容');
}

// ─── 策略1: Code Search API ───

async function searchCode(keyword, perPage = 30) {
  const q = encodeURIComponent(`${keyword} language:markdown`);
  const url = `https://api.github.com/search/code?q=${q}&per_page=${perPage}`;
  try {
    const data = await githubFetch(url);
    return (data.items || []).map(item => ({
      name: item.name,
      path: item.path,
      repo: item.repository.full_name,
      htmlUrl: item.html_url,
      downloadUrl: `https://raw.githubusercontent.com/${item.repository.full_name}/HEAD/${item.path}`,
    }));
  } catch (e) {
    console.log(`  ⚠️ Search失败: ${e.message}`);
    return [];
  }
}

// ─── 处理单个文件 ───

async function processFile(file, companyId, manifest, processedUrls) {
  if (processedUrls.has(file.htmlUrl)) return null;
  processedUrls.add(file.htmlUrl);
  if (urlExists(manifest, file.htmlUrl)) return null;
  if (isUrlGloballyCrawled(file.htmlUrl)) return null;

  // 文件名预过滤
  const nameTitle = file.name.replace(/\.md$/, '').replace(/[-_]/g, ' ');
  const pf = shouldSkipByTitle(nameTitle);
  if (pf.skip) {
    console.log(`  ⏭️ [${pf.reason}] ${file.name}`);
    return null;
  }

  // 跳过太大的文件（>200KB 大概率是知识点汇总不是面经）
  if (file.size && file.size > 200000) {
    console.log(`  ⏭️ [文件过大] ${file.name} (${(file.size/1024).toFixed(0)}KB)`);
    return null;
  }

  await sleep(200);
  let content;
  try {
    content = await downloadViaContentsApi(file.repo, file.path);
  } catch (e) {
    console.log(`  ❌ 下载失败: ${file.name} - ${e.message}`);
    return null;
  }

  if (!content || content.length < 100) {
    console.log(`  ⏭️ [内容太短] ${file.name}`);
    return null;
  }

  // 提取标题
  const h1 = content.match(/^#\s+(.+)$/m);
  const title = h1 ? h1[1].trim() : nameTitle;

  const tf = shouldSkipByTitle(title);
  if (tf.skip) {
    console.log(`  ⏭️ [${tf.reason}] ${title.substring(0, 60)}`);
    return null;
  }

  const cf = shouldSkipByContent(title, content.substring(0, 500));
  if (cf.skip) {
    console.log(`  ⏭️ [${cf.reason}] ${title.substring(0, 40)}`);
    return null;
  }

  if (!matchesCompany(title, content.substring(0, 500), companyId)) {
    console.log(`  ⏭️ [非目标公司] ${title.substring(0, 60)}`);
    return null;
  }

  const repoLabel = file.repo || 'unknown';
  const filePath = saveRawMd(companyId, {
    title,
    url: file.htmlUrl,
    content,
    source: `GitHub (${repoLabel})`,
    publishedAt: new Date().toISOString().slice(0, 10),
  });

  return filePath ? title : null;
}

// ─── 主逻辑 ───

async function crawlOneCompany(task) {
  const { companyId, keywords, limit } = task;
  const config = loadConfig();
  const company = config.targetCompanies.find(c => c.id === companyId);
  if (!company) { console.log(`  ❌ 未找到: ${companyId}`); return { companyId, saved: 0 }; }

  let saved = 0;
  const processedUrls = new Set();
  const manifest = loadManifest(companyId);

  // 搜索词：公司名 + 别名
  const terms = [company.name, ...(company.aliases || []).slice(0, 2)];

  for (const term of terms) {
    if (saved >= limit) break;

    // Search API: "拼多多 面经"
    console.log(`\n🔍 GitHub搜索: ${term} 面经`);
    await sleep(2500); // Search API 限制 10次/min
    const results = await searchCode(`${term} 面经`, 30);
    console.log(`  📋 ${results.length} 个结果`);

    for (const file of results) {
      if (saved >= limit) break;
      const title = await processFile(file, companyId, manifest, processedUrls);
      if (title) {
        saved++;
        console.log(`  ✅ [${saved}/${limit}] ${title.substring(0, 50)}`);
      }
    }

    if (saved >= limit) break;

    // Search API: "拼多多 社招 后端"
    console.log(`\n🔍 GitHub搜索: ${term} 社招 后端`);
    await sleep(2500);
    const results2 = await searchCode(`${term} 社招 后端`, 20);
    console.log(`  📋 ${results2.length} 个结果`);

    for (const file of results2) {
      if (saved >= limit) break;
      const title = await processFile(file, companyId, manifest, processedUrls);
      if (title) {
        saved++;
        console.log(`  ✅ [${saved}/${limit}] ${title.substring(0, 50)}`);
      }
    }
  }

  console.log(`\n✅ ${companyId}: GitHub 保存 ${saved} 条`);
  return { companyId, saved };
}

// ─── 入口 ───

async function main() {
  const args = process.argv.slice(2);
  let workerIdx = 0;
  let tasks = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--worker') workerIdx = parseInt(args[++i]);
    else if (args[i] === '--tasks') tasks = JSON.parse(args[++i]);
    else if (args[i] === '--profile') i++; // GitHub 不需要浏览器 profile
  }

  if (!tasks.length) { console.error('❌ 无任务'); process.exit(1); }

  console.log(`🏃 GitHub Worker ${workerIdx} 启动，${tasks.length} 个公司`);
  if (!GITHUB_TOKEN) console.log('⚠️ 未设置 GITHUB_TOKEN，Search API 不可用');

  const results = [];
  for (let i = 0; i < tasks.length; i++) {
    if (i > 0) await sleep(3000);
    try {
      const r = await Promise.race([
        crawlOneCompany(tasks[i]),
        new Promise((_, rej) => setTimeout(() => rej(new Error('超时(240s)')), 240000)),
      ]);
      results.push(r);
    } catch (e) {
      console.error(`❌ ${tasks[i].companyId}: ${e.message}`);
      results.push({ companyId: tasks[i].companyId, saved: 0, error: e.message });
    }
  }

  console.log(`\n🏁 GitHub Worker ${workerIdx} 完成`);
  results.forEach(r => {
    if (r.error) console.log(`  ❌ ${r.companyId}: ${r.error}`);
    else console.log(`  ✅ ${r.companyId}: ${r.saved} 条`);
  });
  process.exit(0);
}

main().catch(e => { console.error('💥', e.message); process.exit(1); });
