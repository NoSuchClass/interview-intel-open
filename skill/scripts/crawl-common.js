#!/usr/bin/env node
/**
 * 文本类平台爬取公共模块（profile 驱动版）
 * 过滤规则从 profile.json 动态读取，不再硬编码 Java 社招
 */
const path = require('path');
const fs = require('fs');
const { isCrawledUrl, addCrawledUrl } = require('./db');

const DATA_DIR = path.resolve(__dirname, '../../data');
const RAW_BASE = path.join(DATA_DIR, 'raw');
const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');

// ─── 通用过滤（与岗位无关）───

const SKIP_COLLECTION = /题库|面试题合集|面试题汇总|高频题整理|八股文合集|面试宝典|必背|必刷|[0-9]+道.*[题面]|汇总整理|知识点总结|速记|背诵版|常考面试题/;
const SKIP_AD = /卖课|引流|加群|公众号|领取资料|免费领|优惠|报名|训练营|付费|内推码|推广|返现/;
const INTERVIEW_SIGNAL = /面经|面试|一面|二面|三面|笔试|offer|OC|HR面|技术面|社招|面试官|被问|手撕|八股|拷打|凉经|挂了|过了|通过/i;

// ─── Profile 加载 ───

let _profile = null;
let _profileMtime = 0;

function loadProfile() {
  try {
    const stat = fs.statSync(PROFILE_PATH);
    if (stat.mtimeMs !== _profileMtime) {
      _profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8'));
      _profileMtime = stat.mtimeMs;
    }
    return _profile;
  } catch {
    return null;
  }
}

/**
 * 从 profile 生成技术关键词正则
 */
function buildTechRegex(profile) {
  if (!profile?.target?.techKeywords?.length) {
    // 无 profile 时降级为宽松匹配（只要有面经信号就通过）
    return null;
  }
  const escaped = profile.target.techKeywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|'), 'i');
}

/**
 * 从 profile 生成招聘类型过滤规则
 * recruitType: ['social'] → 过滤实习/校招
 * recruitType: ['campus'] → 过滤实习/社招
 * recruitType: ['intern'] → 过滤校招/社招
 * recruitType: ['social', 'campus'] → 只过滤实习
 */
function buildRecruitFilter(profile) {
  const types = profile?.target?.recruitType || ['social'];
  const wantSocial = types.includes('social');
  const wantCampus = types.includes('campus');
  const wantIntern = types.includes('intern');

  return {
    skipIntern: !wantIntern,
    skipCampus: !wantCampus,
    skipSocial: !wantSocial,
  };
}

// ─── 标题级过滤 ───

const SKIP_INTERN_RE = /实习|暑期实习|intern|实习生/i;
const SKIP_CAMPUS_RE = /校招|秋招|春招|应届|campus|提前批|转正|补录|寒假/;
const SKIP_届_RE = /2[2-9]届/;
const SOCIAL_SIGNAL_RE = /社招/;

/**
 * 标题级前置过滤
 * @returns {{ skip: boolean, reason: string }}
 */
function shouldSkipByTitle(title) {
  const t = title;
  const profile = loadProfile();
  const { skipIntern, skipCampus } = buildRecruitFilter(profile);

  if (SKIP_COLLECTION.test(t)) return { skip: true, reason: '题库/合集' };
  if (SKIP_AD.test(t)) return { skip: true, reason: '广告/引流' };

  if (skipIntern && SKIP_INTERN_RE.test(t)) return { skip: true, reason: '非目标类型(实习)' };
  if (skipCampus && SKIP_CAMPUS_RE.test(t) && !SOCIAL_SIGNAL_RE.test(t)) return { skip: true, reason: '非目标类型(校招)' };
  if (skipCampus && SKIP_届_RE.test(t)) return { skip: true, reason: '非目标类型(届)' };

  return { skip: false, reason: '' };
}

// ─── 正文级过滤 ───

/**
 * 正文级过滤（标题+正文前500字）
 * 1. 必须含 profile 技术关键词（无 profile 时跳过此检查）
 * 2. 必须含面经信号词
 * 3. 招聘类型强信号（正文级二次过滤）
 * 4. 题库/合集（正文是批量题目堆砌）
 * 5. 广告/引流（≥3次才判定）
 * 6. 时间过早（2020年之前的面经）
 */
function shouldSkipByContent(title, contentPreview) {
  const combined = title + ' ' + contentPreview;
  const profile = loadProfile();
  const techRegex = buildTechRegex(profile);
  const { skipIntern, skipCampus } = buildRecruitFilter(profile);

  // ── 1. 技术相关性（有 profile 才检查）──
  if (techRegex && !techRegex.test(combined)) {
    return { skip: true, reason: '非目标技术栈' };
  }

  // ── 2. 面经信号词 ──
  if (!INTERVIEW_SIGNAL.test(combined)) return { skip: true, reason: '非面经内容' };

  // ── 3. 招聘类型（正文级，无豁免）──
  if (skipIntern) {
    const INTERN_CONTENT = /实习[面拷]|实习生[面拷]|暑期实习|日常实习|实习offer|实习经[历验]|实习面[经试]|intern\s*(面|offer|interview)/i;
    if (INTERN_CONTENT.test(contentPreview)) return { skip: true, reason: '正文含实习信号' };
  }
  if (skipCampus) {
    const CAMPUS_CONTENT = /校招[面笔]|秋招[面笔]|春招[面笔]|提前批[面笔]|应届[面生]|[2][2-9]届.{0,4}(面|求职|秋招|春招|找工作)/i;
    if (CAMPUS_CONTENT.test(contentPreview)) return { skip: true, reason: '正文含校招信号' };
  }

  // ── 4. 题库/合集 ──
  const COLLECTION_CONTENT = /以下是.{0,6}(面试题|八股)|[0-9]{2,}道.{0,4}(面试|八股|题)|题目汇总|面试题整理|高频[面考]题|必背.{0,4}(面试|八股)|知识点[汇总整理合集]|速记[手卡]册/i;
  if (COLLECTION_CONTENT.test(contentPreview)) return { skip: true, reason: '正文为题库/合集' };

  // ── 5. 广告/引流（≥3次才判定）──
  const AD_WORDS = /卖课|引流|加群|公众号|领取资料|免费领|优惠|报名|训练营|付费|内推码|推广|返现|扫码|加微信|私信|星球/gi;
  const adMatches = contentPreview.match(AD_WORDS);
  if (adMatches && adMatches.length >= 3) return { skip: true, reason: '正文广告/引流过多' };

  // ── 6. 时间过早（2020年之前）──
  const earlyArea = contentPreview.substring(0, 300);
  const EARLY_DATE = /201[0-9]年.{0,6}(面试|面经|求职|找工作|入职)|1[5-9]年.{0,4}(面试|面经|求职|秋招|春招)/;
  if (EARLY_DATE.test(earlyArea)) return { skip: true, reason: '面经时间过早(2020前)' };

  return { skip: false, reason: '' };
}

// ─── 去重 ───

function loadManifest(companyId) {
  const p = path.join(RAW_BASE, companyId, '_manifest.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return { companyId, urls: [], lastFetch: null, totalFiles: 0 }; }
}

function saveManifest(companyId, manifest) {
  const dir = path.join(RAW_BASE, companyId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_manifest.json'), JSON.stringify(manifest, null, 2));
}

function urlExists(manifest, url) {
  const clean = url.split('?')[0];
  return manifest.urls.some(u => u.url.split('?')[0] === clean);
}

// ─── 保存 raw md ───

function getNextFileNumber(companyId) {
  const dir = path.join(RAW_BASE, companyId);
  fs.mkdirSync(dir, { recursive: true });
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}-\d{3}/.test(f));
  if (files.length === 0) return 1;
  const nums = files.map(f => parseInt(f.split('-').slice(3, 4)[0]));
  return Math.max(...nums) + 1;
}

/**
 * 保存面经为 raw md 文件
 * @returns {string|null} 保存的文件路径，失败返回 null
 */
function saveRawMd(companyId, { title, url, content, source, publishedAt }) {
  const manifest = loadManifest(companyId);
  if (urlExists(manifest, url)) return null;

  const today = new Date().toISOString().slice(0, 10);
  const num = String(getNextFileNumber(companyId)).padStart(3, '0');
  const safeTitle = title
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 60);
  const filename = `${today}-${num}-${safeTitle}.md`;
  const filePath = path.join(RAW_BASE, companyId, filename);

  const header = `# ${title}\n\n> 来源：${source}\n> URL：${url}\n> 采集时间：${new Date().toISOString()}\n> 发布时间：${publishedAt || '未知'}\n\n---\n\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, header + content);

  manifest.urls.push({ url, publishedAt: publishedAt || today });
  manifest.lastFetch = new Date().toISOString();
  manifest.totalFiles = (manifest.totalFiles || 0) + 1;
  saveManifest(companyId, manifest);

  try {
    addCrawledUrl(companyId, url.split('?')[0], { source, title, publishedAt });
  } catch (_) { /* DB 写入失败不影响主流程 */ }

  return filePath;
}

// ─── 公司匹配 ───

/**
 * 检查标题/正文是否与目标公司相关
 * 从 profile.json 读取公司列表，不再依赖 _config.json
 */
function matchesCompany(title, contentPreview, companyId) {
  const profile = loadProfile();
  const companies = profile?.companies || [];
  const company = companies.find(c => c.id === companyId);
  if (!company) return false;
  const names = [company.name, ...(company.aliases || [])];
  if (names.some(n => title.includes(n))) return true;
  const shortPreview = contentPreview.substring(0, 200);
  return names.some(n => shortPreview.includes(n));
}

// ─── 全局 URL 去重 ───

function isUrlGloballyCrawled(url) {
  const cleanUrl = url.split('?')[0];
  return isCrawledUrl(cleanUrl);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  shouldSkipByTitle,
  shouldSkipByContent,
  matchesCompany,
  loadManifest,
  saveManifest,
  urlExists,
  saveRawMd,
  isUrlGloballyCrawled,
  loadProfile,
  sleep,
  RAW_BASE,
  DATA_DIR,
};
