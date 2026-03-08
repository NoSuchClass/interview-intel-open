#!/usr/bin/env node
/**
 * 面经情报 Skill 自测脚本
 *
 * 用法：
 *   node test.js           运行所有测试（Layer 1 + Layer 2）
 *   node test.js --unit    只跑 Layer 1 单元测试
 *   node test.js --smoke   只跑 Layer 3 网络冒烟测试（需要网络）
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPTS_DIR = __dirname;
const DATA_DIR = path.resolve(SCRIPTS_DIR, '../../data');

// ─── 测试框架 ───

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    failed++;
    failures.push({ name, error: e.message });
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    failed++;
    failures.push({ name, error: e.message });
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ─── Layer 1: 单元测试（纯逻辑，无副作用）───

function runUnitTests() {
  // 临时写一个 mock profile，让 crawl-common 的 loadProfile 能读到
  const tmpProfile = {
    version: 1,
    target: {
      positions: ['java-backend'],
      recruitType: ['social'],
      techKeywords: ['java', 'jvm', 'spring', 'redis', 'mysql', 'c++'],
    },
    companies: [
      { id: 'bilibili', name: 'B站', aliases: ['哔哩哔哩'] },
      { id: 'bytedance', name: '字节', aliases: ['字节跳动', '抖音'] },
    ],
  };

  // 写到 data/profile.json（测试后恢复）
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const profilePath = path.join(DATA_DIR, 'profile.json');
  const originalProfile = fs.existsSync(profilePath)
    ? fs.readFileSync(profilePath, 'utf-8')
    : null;

  fs.writeFileSync(profilePath, JSON.stringify(tmpProfile, null, 2));

  // 清除 require 缓存，确保读到新 profile
  delete require.cache[require.resolve('./crawl-common')];
  const {
    shouldSkipByTitle,
    shouldSkipByContent,
    matchesCompany,
    loadProfile,
  } = require('./crawl-common');

  // 内部访问 buildTechRegex（通过 loadProfile + 手动构建）
  function buildTechRegex(profile) {
    if (!profile?.target?.techKeywords?.length) return null;
    const escaped = profile.target.techKeywords.map(k =>
      k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
    return new RegExp(escaped.join('|'), 'i');
  }

  section('Layer 1 — buildTechRegex');

  test('普通关键词正则可用', () => {
    const p = { target: { techKeywords: ['java', 'spring', 'redis'] } };
    const re = buildTechRegex(p);
    assert(re !== null, '应返回正则');
    assert(re.test('java面经'), '应匹配 java');
    assert(!re.test('python面经'), '不应匹配 python');
  });

  test('c++ 特殊字符正确转义', () => {
    const p = { target: { techKeywords: ['c++', 'java'] } };
    const re = buildTechRegex(p);
    assert(re !== null, '应返回正则');
    // 不应抛出异常，且能正确匹配
    assert(re.test('c++面经'), '应匹配 c++');
    assert(re.test('java面经'), '应匹配 java');
  });

  test('无 profile 时返回 null', () => {
    const re = buildTechRegex(null);
    assert(re === null, '无 profile 应返回 null');
  });

  test('空 techKeywords 返回 null', () => {
    const re = buildTechRegex({ target: { techKeywords: [] } });
    assert(re === null, '空数组应返回 null');
  });

  section('Layer 1 — shouldSkipByTitle (社招 profile)');

  test('题库/合集标题被过滤', () => {
    const r = shouldSkipByTitle('Java面试题合集100道');
    assert(r.skip, `应过滤，原因: ${r.reason}`);
  });

  test('广告标题被过滤', () => {
    const r = shouldSkipByTitle('字节跳动面经 加群领取资料');
    assert(r.skip, `应过滤，原因: ${r.reason}`);
  });

  test('实习标题被过滤（社招 profile）', () => {
    const r = shouldSkipByTitle('字节跳动暑期实习面经');
    assert(r.skip && r.reason.includes('实习'), `应过滤实习，实际: ${r.reason}`);
  });

  test('校招标题被过滤（社招 profile）', () => {
    const r = shouldSkipByTitle('阿里巴巴2024秋招Java面经');
    assert(r.skip && r.reason.includes('校招'), `应过滤校招，实际: ${r.reason}`);
  });

  test('届数标题被过滤（社招 profile）', () => {
    const r = shouldSkipByTitle('25届秋招字节面经');
    assert(r.skip, `应过滤，原因: ${r.reason}`);
  });

  test('正常社招标题不被过滤', () => {
    const r = shouldSkipByTitle('字节跳动Java后端社招面经');
    assert(!r.skip, `不应过滤，原因: ${r.reason}`);
  });

  test('普通面经标题不被过滤', () => {
    const r = shouldSkipByTitle('美团后端三面面经');
    assert(!r.skip, `不应过滤，原因: ${r.reason}`);
  });

  // 切换到校招 profile 测试
  const campusProfile = {
    ...tmpProfile,
    target: { ...tmpProfile.target, recruitType: ['campus'] },
  };
  fs.writeFileSync(profilePath, JSON.stringify(campusProfile, null, 2));
  delete require.cache[require.resolve('./crawl-common')];
  const cc2 = require('./crawl-common');

  section('Layer 1 — shouldSkipByTitle (校招 profile)');

  test('社招标题被过滤（校招 profile）', () => {
    const r = cc2.shouldSkipByTitle('阿里Java社招面经 3年经验');
    assert(r.skip && r.reason.includes('社招'), `应过滤社招，实际: ${r.reason}`);
  });

  test('校招标题不被过滤（校招 profile）', () => {
    const r = cc2.shouldSkipByTitle('字节2024秋招Java面经');
    assert(!r.skip, `不应过滤，原因: ${r.reason}`);
  });

  test('实习标题被过滤（校招 profile）', () => {
    const r = cc2.shouldSkipByTitle('腾讯暑期实习面经');
    assert(r.skip && r.reason.includes('实习'), `应过滤实习，实际: ${r.reason}`);
  });

  // 恢复社招 profile
  fs.writeFileSync(profilePath, JSON.stringify(tmpProfile, null, 2));
  delete require.cache[require.resolve('./crawl-common')];
  const cc3 = require('./crawl-common');

  section('Layer 1 — shouldSkipByContent');

  test('非面经内容被过滤', () => {
    const r = cc3.shouldSkipByContent('Java学习笔记', 'HashMap的底层原理是数组+链表...');
    assert(r.skip && r.reason.includes('非面经'), `应过滤，实际: ${r.reason}`);
  });

  test('非目标技术栈被过滤', () => {
    const r = cc3.shouldSkipByContent('Python面经', '一面：Django REST framework，二面：Flask...');
    assert(r.skip && r.reason.includes('技术栈'), `应过滤，实际: ${r.reason}`);
  });

  test('正常面经内容通过', () => {
    const r = cc3.shouldSkipByContent(
      '字节Java后端面经',
      '一面：HashMap原理，Redis缓存，JVM GC，Spring IOC，二面：系统设计，三面：HR'
    );
    assert(!r.skip, `不应过滤，原因: ${r.reason}`);
  });

  test('题库正文被过滤', () => {
    const r = cc3.shouldSkipByContent(
      'Java面试题整理',
      '以下是100道Java面试题：1. HashMap原理 2. ConcurrentHashMap...'
    );
    assert(r.skip, `应过滤，原因: ${r.reason}`);
  });

  test('广告密集正文被过滤', () => {
    const r = cc3.shouldSkipByContent(
      '面经分享',
      '一面通过了！加群领取资料，扫码加微信，私信我，训练营报名，付费课程优惠，内推码领取，返现活动'
    );
    assert(r.skip && r.reason.includes('广告'), `应过滤广告，实际: ${r.reason}`);
  });

  section('Layer 1 — matchesCompany');

  test('公司名直接匹配', () => {
    const r = cc3.matchesCompany('B站Java面经', '', 'bilibili');
    assert(r, '应匹配 bilibili');
  });

  test('公司别名匹配', () => {
    const r = cc3.matchesCompany('哔哩哔哩后端面经', '', 'bilibili');
    assert(r, '应通过别名匹配');
  });

  test('正文中匹配公司', () => {
    const r = cc3.matchesCompany('后端面经分享', '今天去字节跳动面试了', 'bytedance');
    assert(r, '应在正文中匹配');
  });

  test('不相关公司不匹配', () => {
    const r = cc3.matchesCompany('阿里面经', '阿里巴巴Java面试', 'bilibili');
    assert(!r, '不应匹配 bilibili');
  });

  test('未知公司 ID 返回 false', () => {
    const r = cc3.matchesCompany('面经', '内容', 'unknown-company-xyz');
    assert(!r, '未知公司应返回 false');
  });

  // 恢复原始 profile
  if (originalProfile) {
    fs.writeFileSync(profilePath, originalProfile);
  } else {
    fs.unlinkSync(profilePath);
  }
  delete require.cache[require.resolve('./crawl-common')];
}
