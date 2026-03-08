#!/usr/bin/env node
/**
 * 小红书并行抓取调度器
 *
 * 基于多浏览器 profile 实现并行抓取，每个 worker 使用独立的 browser-data 目录。
 * Login state is stored at ~/.agent-browser-profile-xhs-data/xiaohongshu
 *
 * 用法：
 *   # 首次登录（打开浏览器，手动扫码）
 *   node xhs-crawl-parallel.js --login
 *
 *   # 初始化多 worker profile（从主 profile 复制登录态）
 *   node xhs-crawl-parallel.js --init-workers 3
 *
 *   # 并行抓取所有公司
 *   node xhs-crawl-parallel.js --all --workers 3 --limit 5
 *
 *   # 并行抓取指定公司
 *   node xhs-crawl-parallel.js --companies alibaba,bytedance --workers 2 --limit 10
 */

const { spawn } = require('child_process');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadProfile, RAW_BASE } = require('./crawl-common');

const SCRIPTS_DIR = __dirname;
const BROWSER_DATA_BASE = path.join(os.homedir(), '.agent-browser-profile-xhs-data');

// ─── Profile 管理 ───

function getProfileDir(workerIdx) {
  if (workerIdx === 0) return path.join(BROWSER_DATA_BASE, 'xiaohongshu');
  return path.join(BROWSER_DATA_BASE, `xiaohongshu-w${workerIdx}`);
}

/**
 * 从主 profile 复制认证文件到 worker profile（保留登录态）
 */
function initWorkerProfile(workerIdx) {
  const src = getProfileDir(0);
  const dst = getProfileDir(workerIdx);

  if (!fs.existsSync(src)) {
    console.error(`❌ 主 profile 不存在: ${src}`);
    console.error('   请先运行: node xhs-crawl-parallel.js --login');
    process.exit(1);
  }

  fs.mkdirSync(dst, { recursive: true });
  fs.mkdirSync(path.join(dst, 'Default'), { recursive: true });

  const filesToCopy = [
    'Local State',
    'Default/Cookies',
    'Default/Cookies-journal',
    'Default/Login Data',
    'Default/Login Data-journal',
    'Default/Web Data',
    'Default/Web Data-journal',
    'Default/Preferences',
    'Default/Secure Preferences',
    'Default/Network/Cookies',
    'Default/Network/Cookies-journal',
  ];

  let copied = 0;
  for (const file of filesToCopy) {
    const srcFile = path.join(src, file);
    const dstFile = path.join(dst, file);
    if (fs.existsSync(srcFile)) {
      fs.mkdirSync(path.dirname(dstFile), { recursive: true });
      fs.copyFileSync(srcFile, dstFile);
      copied++;
    }
  }
  console.log(`  ✅ Worker ${workerIdx}: 复制 ${copied} 个认证文件 → ${path.basename(dst)}`);
}

// ─── 任务分配 ───

/** 将公司列表均匀分配到 N 个 worker */
function distributeCompanies(companies, workerCount) {
  const buckets = Array.from({ length: workerCount }, () => []);
  companies.forEach((c, i) => buckets[i % workerCount].push(c));
  return buckets;
}

// ─── Worker 进程管理 ───

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function launchWorker(workerIdx, companies, limit) {
  return new Promise((resolve) => {
    const companyIds = companies.map(c => c.id);
    const tasks = companies.map(company => {
      const keyword = (company.searchKeywords || [])[0] || `${company.name} 面经`;
      const outDir = path.join(RAW_BASE, company.id);
      return { keyword, outDir, companyId: company.id, limit };
    });

    console.log(`🚀 Worker ${workerIdx}: 负责 [${companyIds.join(', ')}]`);

    const workerScript = path.join(SCRIPTS_DIR, 'xhs-crawl-worker.js');
    const child = spawn('node', [
      workerScript,
      '--worker', String(workerIdx),
      '--tasks', JSON.stringify(tasks),
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    child.stdout.on('data', (data) => {
      data.toString().split('\n').filter(Boolean).forEach(line =>
        console.log(`  [W${workerIdx}] ${line}`)
      );
    });
    child.stderr.on('data', (data) => {
      data.toString().split('\n').filter(Boolean).forEach(line =>
        console.error(`  [W${workerIdx}] ⚠️ ${line}`)
      );
    });

    child.on('close', (code) => {
      resolve({ workerIdx, companies: companyIds, exitCode: code });
    });
  });
}

// ─── 主入口 ───

async function main() {
  const args = process.argv.slice(2);
  let mode = null;
  let workerCount = 3;
  let limit = 5;
  let companyFilter = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--login') { mode = 'login'; }
    else if (args[i] === '--init-workers') { mode = 'init'; workerCount = parseInt(args[++i]); }
    else if (args[i] === '--all') { mode = 'run'; }
    else if (args[i] === '--companies') { mode = 'run'; companyFilter = args[++i].split(','); }
    else if (args[i] === '--workers') { workerCount = parseInt(args[++i]); }
    else if (args[i] === '--limit') { limit = parseInt(args[++i]); }
  }

  if (!mode) {
    console.log(`小红书并行抓取调度器

用法：
  node xhs-crawl-parallel.js --login                                    手动登录（保存 cookie）
  node xhs-crawl-parallel.js --init-workers <N>                         初始化 N 个 worker profile
  node xhs-crawl-parallel.js --all --workers <N> --limit <L>            并行抓取所有公司
  node xhs-crawl-parallel.js --companies a,b --workers <N> --limit <L>  并行抓取指定公司

示例：
  node xhs-crawl-parallel.js --login
  node xhs-crawl-parallel.js --init-workers 3
  node xhs-crawl-parallel.js --all --workers 3 --limit 5
  node xhs-crawl-parallel.js --companies alibaba,bytedance --workers 2 --limit 10`);
    process.exit(0);
  }

  if (mode === 'login') {
    const profileDir = getProfileDir(0);
    fs.mkdirSync(profileDir, { recursive: true });
    console.log(`🔐 打开小红书登录页面...`);
    console.log(`   登录后按 Ctrl+C 关闭浏览器，登录态将自动保存到:`);
    console.log(`   ${profileDir}`);
    const ctx = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://www.xiaohongshu.com', { waitUntil: 'domcontentloaded' });
    console.log('✅ 浏览器已打开，请手动登录，登录后按 Ctrl+C');
    await new Promise(() => {});
  }

  if (mode === 'init') {
    console.log(`🔧 初始化 ${workerCount} 个 worker profile...`);
    for (let i = 1; i <= workerCount; i++) {
      initWorkerProfile(i);
    }
    console.log(`\n✅ 完成！共初始化 ${workerCount} 个 worker profile`);
    console.log('💡 如果登录态失效，重新 --login 后再跑一次 --init-workers');
    return;
  }

  // mode === 'run'
  const profile = loadProfile();
  if (!profile) {
    console.error('❌ 未找到 profile.json，请先运行 node init-profile.js');
    process.exit(1);
  }

  const xhsEnabled = profile.sources?.xiaohongshu;
  if (!xhsEnabled) {
    console.error('❌ 小红书数据源未启用，请在 profile.json 中设置 sources.xiaohongshu: true');
    process.exit(1);
  }

  let companies = profile.companies || [];
  if (companyFilter) {
    companies = companies.filter(c => companyFilter.includes(c.id));
    if (companies.length === 0) {
      console.error(`❌ 未找到匹配的公司: ${companyFilter.join(', ')}`);
      process.exit(1);
    }
  }

  const actualWorkers = Math.min(workerCount, companies.length);
  console.log(`\n📋 任务概览：`);
  console.log(`   公司数: ${companies.length}`);
  console.log(`   Worker 数: ${actualWorkers}`);
  console.log(`   每公司限制: ${limit} 条`);

  // 检查 worker profile 是否存在
  for (let i = 0; i < actualWorkers; i++) {
    const dir = getProfileDir(i);
    if (!fs.existsSync(dir)) {
      console.error(`\n❌ Worker ${i} 的 profile 不存在: ${dir}`);
      if (i === 0) {
        console.error('   请先运行: node xhs-crawl-parallel.js --login');
      } else {
        console.error(`   请先运行: node xhs-crawl-parallel.js --init-workers ${actualWorkers}`);
      }
      process.exit(1);
    }
  }

  const buckets = distributeCompanies(companies, actualWorkers);
  console.log('\n📦 任务分配：');
  buckets.forEach((b, i) => {
    console.log(`   Worker ${i}: ${b.map(c => c.id).join(', ')}`);
  });

  console.log('\n🚀 启动 workers...\n');
  const promises = [];
  for (let i = 0; i < actualWorkers; i++) {
    if (i > 0) {
      const delay = 10000 + Math.random() * 20000;
      console.log(`  ⏳ Worker ${i} 延迟 ${(delay / 1000).toFixed(1)}s 启动（避免风控）`);
      await sleep(delay);
    }
    promises.push(launchWorker(i, buckets[i], limit));
  }

  const results = await Promise.all(promises);

  console.log('\n' + '='.repeat(50));
  console.log('📊 执行结果：');
  for (const r of results) {
    const status = r.exitCode === 0 ? '✅' : '❌';
    console.log(`   ${status} Worker ${r.workerIdx} [${r.companies.join(', ')}] → exit ${r.exitCode}`);
  }
  console.log('\n🎉 全部完成！');
}

main().catch(e => { console.error('💥', e.message); process.exit(1); });
