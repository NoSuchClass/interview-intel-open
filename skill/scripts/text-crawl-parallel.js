#!/usr/bin/env node
/**
 * 文本类平台并行抓取调度器（牛客/掘金/SegmentFault）
 *
 * 每个平台启动独立的 worker 进程，各平台间并行，平台内按公司串行。
 * 所有平台共享同一个 browser profile（agent-browser-profile），不需要像小红书那样多 profile。
 *
 * 用法：
 *   # 三个平台并行抓取所有公司
 *   node text-crawl-parallel.js --all --limit 5
 *
 *   # 指定平台
 *   node text-crawl-parallel.js --sources nowcoder,juejin --all --limit 5
 *
 *   # 指定公司
 *   node text-crawl-parallel.js --companies alibaba,bytedance --limit 5
 *
 *   # 单平台单公司
 *   node text-crawl-parallel.js --sources nowcoder --companies bytedance --limit 10
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPTS_DIR = __dirname;

const WORKER_MAP = {
  nowcoder: 'nowcoder-worker.js',
  juejin: 'juejin-worker.js',
  segmentfault: 'segmentfault-worker.js',
  github: 'github-worker.js',
  csdn: 'csdn-crawl-worker.js',
};

function loadConfig() {
  // 从 profile.json 读取公司列表，不再依赖 _config.json
  const profilePath = path.resolve(SCRIPTS_DIR, '../../data/profile.json');
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
    // 兼容旧接口：把 profile 转成 config 格式
    const enabledSources = Object.entries(profile.sources || {})
      .filter(([, v]) => v)
      .map(([k]) => ({ id: k, enabled: true }));
    return { targetCompanies: profile.companies || [], sources: enabledSources };
  } catch {
    console.error('❌ 未找到 profile.json，请先运行 node init-profile.js');
    process.exit(1);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const WORKER_TIMEOUT = 60 * 60 * 1000; // 整体 worker 超时 60 分钟

/**
 * 启动一个平台的 worker 进程，带整体超时
 */
function launchWorker(sourceId, workerIdx, tasks) {
  return new Promise((resolve) => {
    const workerScript = path.join(SCRIPTS_DIR, WORKER_MAP[sourceId]);
    if (!fs.existsSync(workerScript)) {
      console.error(`❌ Worker 脚本不存在: ${WORKER_MAP[sourceId]}`);
      resolve({ sourceId, workerIdx, exitCode: 1, error: 'script not found' });
      return;
    }

    // nowcoder 需要登录态，使用原始 profile；其他平台用独立 profile
    const baseProfile = path.join(os.homedir(), '.agent-browser-profile');
    const profileDir = sourceId === 'nowcoder'
      ? baseProfile
      : `${baseProfile}-${sourceId}`;

    console.log(`🚀 [${sourceId}] Worker ${workerIdx}: ${tasks.map(t => t.companyId).join(', ')}`);

    const child = spawn('node', [
      workerScript,
      '--worker', String(workerIdx),
      '--profile', profileDir,
      '--tasks', JSON.stringify(tasks),
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      console.error(`⏰ [${sourceId}] Worker 超时(${WORKER_TIMEOUT / 60000}min)，强制终止`);
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    }, WORKER_TIMEOUT);

    child.stdout.on('data', (data) => {
      data.toString().split('\n').filter(Boolean).forEach(line =>
        console.log(`  [${sourceId}] ${line}`)
      );
    });
    child.stderr.on('data', (data) => {
      data.toString().split('\n').filter(Boolean).forEach(line =>
        console.error(`  [${sourceId}] ⚠️ ${line}`)
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ sourceId, workerIdx, exitCode: killed ? 124 : code, timedOut: killed });
    });
  });
}

// ─── 主入口 ───

async function main() {
  const args = process.argv.slice(2);
  let sources = null;
  let companyFilter = null;
  let limit = 5;
  let allCompanies = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sources') sources = args[++i].split(',');
    else if (args[i] === '--companies') companyFilter = args[++i].split(',');
    else if (args[i] === '--all') allCompanies = true;
    else if (args[i] === '--limit') limit = parseInt(args[++i]);
  }

  if (!allCompanies && !companyFilter) {
    console.log(`文本类平台并行抓取调度器

用法：
  node text-crawl-parallel.js --all --limit 5                          三平台并行抓所有公司
  node text-crawl-parallel.js --sources nowcoder,juejin --all --limit 5 指定平台
  node text-crawl-parallel.js --companies alibaba,bytedance --limit 5   指定公司
  node text-crawl-parallel.js --sources nowcoder --companies bytedance --limit 10

可用平台: nowcoder, juejin, segmentfault`);
    process.exit(0);
  }

  const config = loadConfig();

  // 确定启用的平台
  const enabledSources = config.sources
    .filter(s => s.enabled && WORKER_MAP[s.id])
    .map(s => s.id);

  const activeSources = sources
    ? sources.filter(s => enabledSources.includes(s))
    : enabledSources;

  if (activeSources.length === 0) {
    console.error('❌ 没有可用的文本类平台');
    process.exit(1);
  }

  // 确定公司列表
  let companies = config.targetCompanies;
  if (companyFilter) {
    companies = companies.filter(c => companyFilter.includes(c.id));
    if (companies.length === 0) {
      console.error(`❌ 未找到匹配的公司: ${companyFilter.join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`\n📋 任务概览：`);
  console.log(`   平台: ${activeSources.join(', ')}`);
  console.log(`   公司数: ${companies.length}`);
  console.log(`   每公司每平台限制: ${limit} 条`);

  // 为每个平台生成任务列表
  const profilePath = path.resolve(SCRIPTS_DIR, '../../data/profile.json');
  let profile = null;
  try { profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8')); } catch {}
  const recruitTypes = profile?.target?.recruitType || ['social'];
  const positions = profile?.target?.positions || ['java-backend'];

  // 根据 recruitType 生成招聘类型关键词
  const recruitKws = [];
  if (recruitTypes.includes('campus')) recruitKws.push('校招', '秋招', '春招');
  if (recruitTypes.includes('social')) recruitKws.push('社招');
  if (recruitTypes.includes('intern')) recruitKws.push('实习');

  // 根据 positions 生成技术关键词
  const techKws = [];
  if (positions.includes('java-backend')) techKws.push('Java', '后端');
  if (positions.includes('go-backend')) techKws.push('Go', 'Golang', '后端');
  if (positions.includes('frontend')) techKws.push('前端');
  if (positions.includes('cpp')) techKws.push('C++', '后端');
  if (positions.includes('python')) techKws.push('Python', '后端');
  if (positions.includes('ai-agent')) techKws.push('算法', 'AI');
  if (positions.includes('test')) techKws.push('测试', '测开');
  if (positions.includes('data')) techKws.push('大数据');
  if (techKws.length === 0) techKws.push('后端');

  const promises = [];
  for (let i = 0; i < activeSources.length; i++) {
    const sourceId = activeSources[i];
    const tasks = companies.map(c => {
      // 基础关键词：公司名 × 技术方向 × 招聘类型 组合
      const baseKws = [];
      for (const tech of techKws.slice(0, 2)) {
        for (const rt of recruitKws.length ? recruitKws : ['']) {
          baseKws.push(rt ? `${c.name} ${tech} ${rt} 面经` : `${c.name} ${tech} 面经`);
        }
      }
      // 通用面经词（兜底）
      baseKws.push(`${c.name} 面经`);

      return {
        companyId: c.id,
        keywords: [
          ...(c.searchKeywords || []),
          ...baseKws,
        ].filter((v, idx, arr) => arr.indexOf(v) === idx), // 去重
        limit,
      };
    });

    // 平台间错开 5-15 秒启动
    if (i > 0) {
      const delay = 5000 + Math.random() * 10000;
      console.log(`\n⏳ ${sourceId} 延迟 ${(delay / 1000).toFixed(1)}s 启动`);
      await sleep(delay);
    }

    promises.push(launchWorker(sourceId, i, tasks));
  }

  // 等待所有 worker 完成
  const results = await Promise.all(promises);

  console.log('\n' + '='.repeat(50));
  console.log('📊 执行结果：');
  for (const r of results) {
    const status = r.timedOut ? '⏰' : r.exitCode === 0 ? '✅' : '❌';
    const extra = r.timedOut ? ' (超时终止)' : '';
    console.log(`   ${status} ${r.sourceId} → exit ${r.exitCode}${extra}`);
  }
  console.log('\n🎉 全部完成！');
}

main().catch(e => { console.error('💥', e.message); process.exit(1); });
