#!/usr/bin/env node
/**
 * 面经情报 — Profile 初始化脚本
 *
 * 用法：
 *   node init-profile.js                          交互式生成 profile
 *   node init-profile.js --template java-social    从模板快速生成
 *   node init-profile.js --quick "Go 社招"         一句话快速生成
 *   node init-profile.js --show                    查看当前 profile
 *   node init-profile.js --set-token <token>       设置远程推送 token
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = path.resolve(__dirname, '../../data');
const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');
const TEMPLATES_DIR = path.resolve(__dirname, '../templates');

// ─── 岗位方向定义 ───

const POSITIONS = {
  'java-backend': { name: 'Java 后端', techKeywords: ['java', 'jvm', 'spring', 'springboot', 'redis', 'kafka', 'mysql', '并发', '线程池', '分布式', '微服务', 'mq', 'rpc', 'dubbo', 'netty', 'mybatis', 'hashmap', 'gc', '后端', 'backend'] },
  'go-backend':   { name: 'Go 后端',   techKeywords: ['go', 'golang', 'goroutine', 'channel', 'gin', 'grpc', 'protobuf', 'redis', 'kafka', 'mysql', '并发', '分布式', '微服务', 'etcd', 'docker', 'kubernetes', 'k8s', '后端', 'backend'] },
  'frontend':     { name: '前端',      techKeywords: ['前端', 'frontend', 'react', 'vue', 'angular', 'javascript', 'typescript', 'css', 'html', 'webpack', 'vite', 'node', '浏览器', 'dom', 'http', '性能优化', '小程序'] },
  'cpp':          { name: 'C++',       techKeywords: ['c++', 'cpp', 'stl', '多线程', '内存管理', 'linux', '操作系统', '网络编程', 'socket', 'epoll', '后端', 'backend'] },
  'python':       { name: 'Python',    techKeywords: ['python', 'django', 'flask', 'fastapi', 'redis', 'mysql', '爬虫', '后端', 'backend'] },
  'test':         { name: '测试',      techKeywords: ['测试', '测开', 'QA', '自动化测试', 'selenium', 'pytest', 'jmeter', '性能测试', '接口测试'] },
  'data':         { name: '大数据',    techKeywords: ['大数据', 'hadoop', 'spark', 'flink', 'hive', 'hbase', 'kafka', '数据仓库', 'etl', '数据开发'] },
  'fullstack':    { name: '全栈',      techKeywords: ['全栈', 'fullstack', 'react', 'vue', 'node', 'java', 'spring', 'redis', 'mysql'] },
};

const RECRUIT_TYPES = {
  'social': '社招',
  'campus': '校招',
  'intern': '实习',
};

const DEFAULT_COMPANIES = [
  { id: 'alibaba', name: '阿里', aliases: ['阿里巴巴', '淘天', '蚂蚁', '阿里云', '饿了么', '高德'] },
  { id: 'bytedance', name: '字节', aliases: ['字节跳动', '抖音', 'TikTok', '飞书'] },
  { id: 'meituan', name: '美团', aliases: ['大众点评'] },
  { id: 'pdd', name: '拼多多', aliases: ['PDD', 'Temu'] },
  { id: 'tencent', name: '腾讯', aliases: ['微信', '腾讯云'] },
  { id: 'baidu', name: '百度', aliases: [] },
  { id: 'jd', name: '京东', aliases: ['京东物流'] },
  { id: 'xiaomi', name: '小米', aliases: [] },
  { id: 'netease', name: '网易', aliases: ['网易互娱', '网易云音乐'] },
  { id: 'didi', name: '滴滴', aliases: ['滴滴出行'] },
  { id: 'kuaishou', name: '快手', aliases: [] },
  { id: 'bilibili', name: 'B站', aliases: ['哔哩哔哩'] },
  { id: 'shopee', name: 'Shopee', aliases: ['虾皮'] },
  { id: 'dewu', name: '得物', aliases: [] },
  { id: 'ctrip', name: '携程', aliases: ['去哪儿', 'Trip.com'] },
  { id: 'xiaohongshu', name: '小红书', aliases: [] },
];

// ─── 工具函数 ───

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function loadProfile() {
  try { return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8')); }
  catch { return null; }
}

function saveProfile(profile) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  profile.createdAt = new Date().toISOString();
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));
  console.log(`\n✅ Profile 已保存到 ${PROFILE_PATH}`);
}

function loadTemplate(name) {
  const p = path.join(TEMPLATES_DIR, `profile-${name}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// ─── 一句话快速推断 ───

function inferFromQuick(text) {
  const t = text.toLowerCase();
  const profile = {
    version: 1, name: text,
    target: { positions: [], recruitType: [], level: [], techKeywords: [], excludeKeywords: [] },
    companies: DEFAULT_COMPANIES,
    sources: { nowcoder: true, csdn: true, github: true, xiaohongshu: false, 'web-search': true },
    remote: { enabled: false, siteUrl: 'http://106.54.196.46:4173', token: '' },
  };

  // 推断岗位
  if (/java|jvm|spring/.test(t)) profile.target.positions.push('java-backend');
  if (/\bgo\b|golang/.test(t)) profile.target.positions.push('go-backend');
  if (/前端|frontend|react|vue/.test(t)) profile.target.positions.push('frontend');
  if (/c\+\+|cpp/.test(t)) profile.target.positions.push('cpp');
  if (/python|django|flask/.test(t)) profile.target.positions.push('python');
  if (/测试|测开|qa/.test(t)) profile.target.positions.push('test');
  if (/大数据|hadoop|spark|flink/.test(t)) profile.target.positions.push('data');
  if (/全栈|fullstack/.test(t)) profile.target.positions.push('fullstack');
  if (profile.target.positions.length === 0) profile.target.positions.push('java-backend');

  // 推断招聘类型
  if (/社招/.test(t)) profile.target.recruitType.push('social');
  if (/校招|秋招|春招/.test(t)) profile.target.recruitType.push('campus');
  if (/实习/.test(t)) profile.target.recruitType.push('intern');
  if (profile.target.recruitType.length === 0) profile.target.recruitType.push('social');

  // 合并 techKeywords
  for (const pos of profile.target.positions) {
    if (POSITIONS[pos]) {
      profile.target.techKeywords.push(...POSITIONS[pos].techKeywords);
    }
  }
  profile.target.techKeywords = [...new Set(profile.target.techKeywords)];

  // 推断级别
  if (/p5/.test(t)) profile.target.level.push('P5');
  if (/p6/.test(t)) profile.target.level.push('P6');
  if (/p7/.test(t)) profile.target.level.push('P7');

  return profile;
}

// ─── 交互式生成 ───

async function interactiveGenerate() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n🎯 面经情报 — Profile 配置向导\n');

  // 1. 岗位方向
  console.log('可选岗位方向：');
  Object.entries(POSITIONS).forEach(([k, v], i) => console.log(`  ${i + 1}. ${v.name} (${k})`));
  const posInput = await ask(rl, '\n选择岗位方向（输入编号，多选用逗号分隔，默认 1）: ');
  const posIndices = (posInput.trim() || '1').split(',').map(s => parseInt(s.trim()) - 1);
  const posKeys = Object.keys(POSITIONS);
  const positions = posIndices.filter(i => i >= 0 && i < posKeys.length).map(i => posKeys[i]);
  if (positions.length === 0) positions.push('java-backend');

  // 2. 招聘类型
  console.log('\n可选招聘类型：');
  Object.entries(RECRUIT_TYPES).forEach(([k, v], i) => console.log(`  ${i + 1}. ${v} (${k})`));
  console.log('  4. 都要');
  const rtInput = await ask(rl, '\n选择招聘类型（默认 1）: ');
  const rtIdx = parseInt(rtInput.trim() || '1');
  const rtKeys = Object.keys(RECRUIT_TYPES);
  const recruitType = rtIdx === 4 ? [...rtKeys] : [rtKeys[Math.min(rtIdx - 1, rtKeys.length - 1)] || 'social'];

  // 3. 目标公司
  console.log('\n预设公司列表：');
  DEFAULT_COMPANIES.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}. ${c.name}`));
  const compInput = await ask(rl, '\n选择公司（输入编号，多选用逗号分隔，直接回车=全部）: ');
  let companies;
  if (!compInput.trim()) {
    companies = DEFAULT_COMPANIES;
  } else {
    const indices = compInput.split(',').map(s => parseInt(s.trim()) - 1);
    companies = indices.filter(i => i >= 0 && i < DEFAULT_COMPANIES.length).map(i => DEFAULT_COMPANIES[i]);
    if (companies.length === 0) companies = DEFAULT_COMPANIES;
  }

  // 4. 远程推送
  const remoteInput = await ask(rl, '\n是否推送到公共面经情报站？(y/N): ');
  const remoteEnabled = /^y/i.test(remoteInput.trim());
  let token = '';
  if (remoteEnabled) {
    token = await ask(rl, '请输入 MCP Token（从 http://106.54.196.46:4173 个人中心获取）: ');
  }

  rl.close();

  // 合并 techKeywords
  const techKeywords = [...new Set(positions.flatMap(p => POSITIONS[p]?.techKeywords || []))];

  const profile = {
    version: 1,
    name: `${positions.map(p => POSITIONS[p]?.name || p).join('+')} ${recruitType.map(r => RECRUIT_TYPES[r] || r).join('+')}`,
    target: { positions, recruitType, level: [], techKeywords, excludeKeywords: [] },
    companies,
    sources: { nowcoder: true, csdn: true, github: true, xiaohongshu: false, 'web-search': true },
    remote: { enabled: remoteEnabled, siteUrl: 'http://106.54.196.46:4173', token: token.trim() },
  };

  return profile;
}

// ─── 主入口 ───

async function main() {
  const args = process.argv.slice(2);

  // --show
  if (args.includes('--show')) {
    const p = loadProfile();
    if (!p) { console.log('尚未创建 profile，运行 node init-profile.js 生成'); return; }
    console.log(JSON.stringify(p, null, 2));
    return;
  }

  // --set-token
  const tokenIdx = args.indexOf('--set-token');
  if (tokenIdx >= 0) {
    const token = args[tokenIdx + 1];
    if (!token) { console.log('用法: node init-profile.js --set-token <token>'); return; }
    const p = loadProfile();
    if (!p) { console.log('尚未创建 profile，请先运行 node init-profile.js'); return; }
    p.remote = p.remote || {};
    p.remote.enabled = true;
    p.remote.token = token;
    saveProfile(p);
    return;
  }

  // --template
  const tplIdx = args.indexOf('--template');
  if (tplIdx >= 0) {
    const tplName = args[tplIdx + 1];
    const tpl = loadTemplate(tplName);
    if (!tpl) {
      const available = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('profile-', '').replace('.json', ''));
      console.log(`模板 "${tplName}" 不存在。可用模板: ${available.join(', ')}`);
      return;
    }
    saveProfile(tpl);
    return;
  }

  // --quick
  const quickIdx = args.indexOf('--quick');
  if (quickIdx >= 0) {
    const text = args.slice(quickIdx + 1).join(' ');
    if (!text) { console.log('用法: node init-profile.js --quick "Go 社招"'); return; }
    const profile = inferFromQuick(text);
    console.log(`\n🔍 从 "${text}" 推断：`);
    console.log(`   岗位: ${profile.target.positions.map(p => POSITIONS[p]?.name || p).join(', ')}`);
    console.log(`   类型: ${profile.target.recruitType.map(r => RECRUIT_TYPES[r] || r).join(', ')}`);
    saveProfile(profile);
    return;
  }

  // 默认：交互式
  const profile = await interactiveGenerate();
  saveProfile(profile);
}

main().catch(e => { console.error(e.message); process.exit(1); });
