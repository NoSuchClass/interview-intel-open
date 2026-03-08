#!/usr/bin/env node
/**
 * 面经数据查询 CLI（SQLite 版）
 *
 * 用法：
 *   node query.js --query [--module X] [--company X] [--difficulty X] [--kp a,b] [--type X] [--keyword X] [--limit N]
 *   node query.js --hot-topics [--module X] [--company X]
 *   node query.js --company-style <companyId>
 *   node query.js --stats
 */

const db = require('./db');

function compact(obj) {
  if (Array.isArray(obj)) return obj.map(compact);
  if (obj && typeof obj === 'object') {
    const r = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      r[k] = compact(v);
    }
    return r;
  }
  return obj;
}

// ============ 命令实现 ============

function cmdQuery(args) {
  const filters = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--module') filters.module = args[++i];
    else if (args[i] === '--company') filters.company = args[++i];
    else if (args[i] === '--difficulty') filters.difficulty = args[++i];
    else if (args[i] === '--kp') filters.knowledgePoints = args[++i].split(',');
    else if (args[i] === '--type') filters.type = args[++i];
    else if (args[i] === '--keyword') filters.keyword = args[++i];
    else if (args[i] === '--style') filters.style = args[++i];
    else if (args[i] === '--depth') filters.depth = args[++i];
    else if (args[i] === '--experience') filters.experienceYears = args[++i];
    else if (args[i] === '--limit') filters.limit = parseInt(args[++i]);
  }

  const results = db.queryQuestions(filters);
  if (!results.length) { console.log('未找到匹配的面经题目。'); return; }

  const output = compact(results.map((r, i) => ({
    '#': i + 1,
    id: r.id,
    topic: r.topic,
    module: r.module,
    type: r.type,
    difficulty: r.difficulty,
    questionStyle: r.question_style,
    depthLevel: r.depth_level,
    content: r.content,
    rawContent: r.raw_content,
    followUps: r.followUps,
    knowledgePoints: r.knowledgePoints,
    company: r.company_name,
    trace: r.trace,
  })));
  console.log(JSON.stringify(output, null, 2));
}

function cmdHotTopics(args) {
  let module = null, company = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--module') module = args[++i];
    else if (args[i] === '--company') company = args[++i];
  }

  const hotTopics = db.getHotTopics(module, company);
  const output = {};
  for (const [mod, data] of Object.entries(hotTopics)) {
    output[mod] = {
      total: data.totalMentions,
      topTopics: data.topQuestions.slice(0, 5).map(q =>
        `${q.topic}(${q.frequency}次,${q.companies.join('/')})`
      ),
    };
  }
  console.log(JSON.stringify(compact(output), null, 2));
}

function cmdCompanyStyle(companyId) {
  const style = db.getCompanyProfile(companyId);
  if (!style) { console.log(`${companyId} 暂无面经数据。`); return; }
  console.log(JSON.stringify(compact(style), null, 2));
}

function cmdStats() {
  const stats = db.getStats();
  console.log(JSON.stringify(compact(stats), null, 2));
}

// ============ 新增命令 ============

function cmdTrace(args) {
  let id = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id') id = parseInt(args[++i]);
  }
  if (!id) { console.log('用法: --trace --id <questionId>'); return; }
  const result = db.getQuestionTrace(id);
  if (!result) { console.log(`题目 #${id} 不存在。`); return; }
  console.log(JSON.stringify(compact(result), null, 2));
}

function cmdFrequencyRank(args) {
  let module = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--module') module = args[++i];
  }
  const result = db.getFrequencyRank(module);
  console.log(JSON.stringify(compact(result), null, 2));
}

function cmdFollowUpPatterns(args) {
  let kp = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--kp') kp = args[++i];
  }
  if (!kp) { console.log('用法: --follow-up-patterns --kp <knowledgePoint>'); return; }
  const result = db.getFollowUpPatterns(kp);
  console.log(JSON.stringify(compact(result), null, 2));
}

function cmdCrossCompany(args) {
  let minCompanies = 3, limit = 20;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--min-companies') minCompanies = parseInt(args[++i]);
    else if (args[i] === '--limit') limit = parseInt(args[++i]);
  }
  const result = db.getCrossCompanyTopics(minCompanies, limit);
  console.log(JSON.stringify(compact(result), null, 2));
}

function cmdComboPatterns(args) {
  let kp = null, limit = 10;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--kp') kp = args[++i];
    else if (args[i] === '--limit') limit = parseInt(args[++i]);
  }
  if (!kp) { console.log('用法: --combo-patterns --kp <knowledgePoint>'); return; }
  const result = db.getComboPatterns(kp, limit);
  console.log(JSON.stringify(compact(result), null, 2));
}

function cmdTrend(args) {
  let kp = null, granularity = 'quarter';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--kp') kp = args[++i];
    else if (args[i] === '--granularity') granularity = args[++i];
  }
  if (!kp) { console.log('用法: --trend --kp <knowledgePoint> [--granularity quarter|month]'); return; }
  const result = db.getTrendTimeline(kp, granularity);
  console.log(JSON.stringify(compact(result), null, 2));
}

function cmdCoverage(args) {
  let module = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--module') module = args[++i];
  }
  if (!module) { console.log('用法: --coverage --module <moduleName>'); return; }
  const result = db.getCoverageAnalysis(module);
  console.log(JSON.stringify(compact(result), null, 2));
}

function cmdRoundAnalysis(args) {
  let module = null, company = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--module') module = args[++i];
    else if (args[i] === '--company') company = args[++i];
  }
  const result = db.getRoundAnalysis(module, company);
  console.log(JSON.stringify(compact(result), null, 2));
}

function cmdExperienceAnalysis(args) {
  let module = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--module') module = args[++i];
  }
  const result = db.getExperienceAnalysis(module);
  console.log(JSON.stringify(compact(result), null, 2));
}

// ============ 入口 ============

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === '--query') cmdQuery(args.slice(1));
else if (cmd === '--hot-topics') cmdHotTopics(args.slice(1));
else if (cmd === '--company-style') cmdCompanyStyle(args[1]);
else if (cmd === '--stats') cmdStats();
else if (cmd === '--trace') cmdTrace(args.slice(1));
else if (cmd === '--frequency-rank') cmdFrequencyRank(args.slice(1));
else if (cmd === '--follow-up-patterns') cmdFollowUpPatterns(args.slice(1));
else if (cmd === '--cross-company') cmdCrossCompany(args.slice(1));
else if (cmd === '--combo-patterns') cmdComboPatterns(args.slice(1));
else if (cmd === '--trend') cmdTrend(args.slice(1));
else if (cmd === '--coverage') cmdCoverage(args.slice(1));
else if (cmd === '--round-analysis') cmdRoundAnalysis(args.slice(1));
else if (cmd === '--experience-analysis') cmdExperienceAnalysis(args.slice(1));
else {
  console.log(`用法：
  node query.js --query [--module X] [--company X] [--difficulty X] [--kp a,b] [--type X] [--keyword X] [--style X] [--depth X] [--experience X] [--limit N]
  node query.js --hot-topics [--module X] [--company X]
  node query.js --company-style <companyId>
  node query.js --stats
  node query.js --trace --id <questionId>
  node query.js --frequency-rank [--module X]
  node query.js --follow-up-patterns --kp <knowledgePoint>
  node query.js --cross-company [--min-companies N] [--limit N]
  node query.js --combo-patterns --kp <knowledgePoint> [--limit N]
  node query.js --trend --kp <knowledgePoint> [--granularity quarter|month]
  node query.js --coverage --module <moduleName>
  node query.js --round-analysis [--module X] [--company X]
  node query.js --experience-analysis [--module X]`);
}

db.closeDb();
