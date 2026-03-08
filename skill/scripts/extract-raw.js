#!/usr/bin/env node
/**
 * 面经结构化提取脚本 — Kiro 驱动模式（SQLite 版）
 *
 * 用法：
 *   node extract-raw.js --list [company]              列出待处理文件和 prompt
 *   node extract-raw.js --save <company> <file>       从 stdin 读取提取结果并保存
 *   node extract-raw.js --merge-list [company]        列出待合并数据和 prompt
 *   node extract-raw.js --merge-save <company> <mod>  从 stdin 读取合并结果并保存
 *   node extract-raw.js --hot-topics                  更新全局热点（无需 LLM）
 *   node extract-raw.js --dry                         预览待处理文件
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const INTEL_DIR = db.DB_DIR;
const RAW_DIR = path.join(INTEL_DIR, 'raw');

// 从 DB 动态读取公司列表，不再依赖 _config.json
function loadCompanies() {
  try {
    return db.getDb().prepare('SELECT id, name, aliases FROM companies').all().map(c => ({
      id: c.id,
      name: c.name,
      aliases: JSON.parse(c.aliases || '[]'),
    }));
  } catch { return []; }
}

// ============ Prompt 模板 ============

const EXTRACTION_SYSTEM_PROMPT = `你是一个技术面试分析专家。从面经文本中提取结构化信息，严格按 JSON 格式返回。

## 提取规则

1. company：识别公司名（阿里/字节/美团/拼多多/携程），支持别名（淘天=阿里，抖音=字节）
2. companyId：公司标识（alibaba/bytedance/meituan/pdd/ctrip/xiaomi/kuaishou/shopee/baidu/netease/jd/didi/other）
3. level：识别职级（P5/P6/P7），无明确信息则根据题目难度推断
4. module：每个问题归类到模块（kafka/redis/mysql/concurrent/jvm/java-basic/spring/microservice/system-design/network/os/mq/distributed）
5. knowledgePoints：用短横线命名风格（如 acks-mechanism, isr-mechanism）
6. difficulty：根据追问深度判断（单层概念=P5，源码级=P6，架构设计=P7）
7. 如果文本中包含多轮面试，合并所有轮次的题目，每道题标注 round
8. 如果文本不是面经（如新闻、广告、技术文章），返回 {"skip": true, "reason": "非面经内容"}

## 原子拆分规则

一个编号下如果包含多个独立知识点（多个问号、"以及"、"还有"连接的不同问题），必须拆分为多条记录：
- "HashMap 的底层结构？扩容机制？" → 拆为 2 条
- "Redis 的持久化方式有哪些？RDB 和 AOF 的区别？" → 拆为 2 条
- "说说 synchronized 的原理" → 1 条（单一知识点）

例外（不拆分）：
- 项目深挖类：围绕同一个项目的连续追问，合并为 1 条，type 标为 "project-deep-dive"
- 算法题：题目描述 + 追问优化，合并为 1 条
- 系统设计题：一个完整的设计题 + 追问细节，合并为 1 条

## 新字段说明

- questionStyle：考察方式，必须是以下之一：
  concept（概念理解）/ principle（原理机制）/ source-code（源码分析）/ comparison（对比分析）/
  scenario（场景应用）/ troubleshoot（故障排查）/ coding（编码实现）/ system-design（系统设计）/
  best-practice（最佳实践）/ trade-off（权衡取舍）/ anti-pattern（反模式识别）/ experience（经验分享）/
  cross-domain（跨领域）/ evolution（技术演进）/ project-deep-dive（项目深挖）/ implementation（实现细节）/
  optimization（性能优化）/ boundary（边界条件）/ why-not（反向追问）/ workflow（工作流程）/
  config-tuning（配置调优）/ monitoring（监控运维）/ reliability（可靠性保障）/ data-consistency（数据一致性）

- depthLevel：追问深度，必须是以下之一：
  surface（表层概念）/ mechanism（机制原理）/ source（源码级）/ design（架构设计级）

- rawContent：保留面试官的原话，不做归一化处理
- content：归一化后的题目描述（清晰、标准化）
- answerHint：参考答案要点（简要关键点，供 AI 出题时参考）

- followUps：追问链，使用对象数组格式：
  [{"content": "追问内容", "parentIndex": null, "depth": 0}, {"content": "更深追问", "parentIndex": 0, "depth": 1}]
  parentIndex 指向父追问在数组中的索引（null 表示顶层追问），depth 表示追问深度层级

- relatedTopics：与当前题目相关的其他知识点标识列表（如 ["volatile", "cas"]）

- result：面试结果（pass/fail/unknown），从面经正文中识别
- experienceYears：候选人经验年限（如 "3-5"、"5+"），从面经正文中识别

只返回 JSON，不要任何解释文字。返回格式：
{
  "company": "string",
  "companyId": "string",
  "level": "string",
  "department": "string | null",
  "rounds": number,
  "result": "pass|fail|unknown",
  "experienceYears": "string | null",
  "questions": [
    {
      "module": "string",
      "topic": "string",
      "type": "简答|场景设计|代码题|系统设计|八股|追问链|project-deep-dive",
      "questionStyle": "concept|principle|source-code|comparison|scenario|troubleshoot|coding|system-design|best-practice|trade-off|anti-pattern|experience|cross-domain|evolution|project-deep-dive|implementation|optimization|boundary|why-not|workflow|config-tuning|monitoring|reliability|data-consistency",
      "depthLevel": "surface|mechanism|source|design",
      "difficulty": "P5|P6|P7",
      "content": "归一化题目描述",
      "rawContent": "面试官原话",
      "answerHint": "参考答案要点",
      "round": 1,
      "followUps": [{"content": "string", "parentIndex": null, "depth": 0}],
      "knowledgePoints": ["string"],
      "relatedTopics": ["string"]
    }
  ],
  "jdHighlights": ["string"]
}`;

const MERGE_SYSTEM_PROMPT = `你是面试题目去重合并专家。给定同一模块下的多道面试题，将语义相同/高度相似的题目合并。

规则：
1. 语义相同的题目合并为一条，保留最完整的表述
2. 合并后记录 frequency（出现次数）和 companies（出现的公司列表）
3. followUps 取并集
4. knowledgePoints 取并集
5. difficulty 取最高值
6. 不相似的题目保持独立

返回 JSON 数组，每个元素：
{
  "topic": "string",
  "content": "string（最完整的表述）",
  "type": "string",
  "difficulty": "P5|P6|P7",
  "followUps": ["string"],
  "knowledgePoints": ["string"],
  "frequency": number,
  "companies": ["string"]
}`;

// ============ 工具函数 ============

function parseRawMd(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const urlMatch = text.match(/> URL：(.+)/);
  const sourceMatch = text.match(/> 来源：(.+)/);
  const publishMatch = text.match(/> 发布时间：(.+)/);
  const titleMatch = text.match(/^# (.+)/m);
  const bodyStart = text.indexOf('---');
  const content = bodyStart >= 0 ? text.slice(bodyStart + 3).trim() : text;
  return {
    title: titleMatch?.[1] || path.basename(filePath, '.md'),
    url: urlMatch?.[1]?.trim() || '',
    source: sourceMatch?.[1]?.trim() || '未知',
    publishedAt: publishMatch?.[1]?.trim() || null,
    content
  };
}

function parseJson(text) {
  try {
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(cleaned);
  } catch { return null; }
}

// ============ 命令：--list ============

function cmdList(companyFilter) {
  const allCompanies = loadCompanies();
  const companies = companyFilter && companyFilter !== 'all'
    ? [companyFilter]
    : allCompanies.map(c => c.id);

  const result = [];

  for (const companyId of companies) {
    const cc = allCompanies.find(c => c.id === companyId) || { id: companyId, name: companyId, aliases: [] };

    const rawDir = path.join(RAW_DIR, companyId);
    if (!fs.existsSync(rawDir)) continue;

    const files = fs.readdirSync(rawDir).filter(f => f.endsWith('.md') && !f.startsWith('_')).sort();
    if (!files.length) continue;

    const processed = db.getProcessedUrls(companyId);

    for (const file of files) {
      const raw = parseRawMd(path.join(rawDir, file));
      if (raw.url && processed.has(raw.url)) continue;
      if (!raw.content || raw.content.length < 50) continue;

      const truncated = raw.content.length > 4000 ? raw.content.slice(0, 4000) + '\n...(截断)' : raw.content;

      result.push({
        companyId,
        companyName: cc.name,
        file,
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
        userPrompt: truncated,
        meta: { source: raw.source, url: raw.url, publishedAt: raw.publishedAt }
      });
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

// ============ 命令：--save ============

function cmdSave(companyId, fileName) {
  let input = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    const json = parseJson(input);
    if (!json) { console.error('❌ JSON 解析失败'); process.exit(1); }
    if (json.skip) { console.error(`⏭️ 非面经: ${json.reason || ''}`); process.exit(0); }
    if (!json.questions?.length) { console.error('⚠️ 无有效题目'); process.exit(0); }

    const cc = loadCompanies().find(c => c.id === companyId);

    // 确保公司存在
    if (!db.getCompany(companyId)) {
      db.upsertCompany({ id: companyId, name: cc?.name || companyId, aliases: cc?.aliases || [], searchKeywords: [] });
    }

    const rawPath = path.join(RAW_DIR, companyId, fileName);
    const raw = fs.existsSync(rawPath) ? parseRawMd(rawPath) : {};

    const interviewId = db.generateInterviewId(companyId);

    db.insertInterview({
      id: interviewId,
      companyId,
      source: raw.source || '未知',
      sourceUrl: raw.url || '',
      publishedAt: raw.publishedAt || null,
      date: raw.publishedAt?.slice(0, 7) || new Date().toISOString().slice(0, 7),
      level: json.level || 'P6',
      department: json.department,
      rounds: json.rounds || 1,
      questions: json.questions,
      jdHighlights: json.jdHighlights || [],
    });

    db.refreshHotTopics();

    const total = db.getInterviewCount(companyId);
    console.log(JSON.stringify({ ok: true, questions: json.questions.length, level: json.level || 'P6', total }));
  });
}

// ============ 命令：--save --file ============

function cmdSaveFromFile(companyId, fileName, jsonFile) {
  const input = fs.readFileSync(jsonFile, 'utf-8');
  const json = parseJson(input);
  if (!json) { console.error('❌ JSON 解析失败'); process.exit(1); }
  if (json.skip) {
    // Log skip to extraction_log
    db.logExtraction({ companyId, filename: fileName, status: 'skipped', skipReason: json.reason || '非面经内容' });
    console.error(`⏭️ 非面经: ${json.reason || ''}`);
    process.exit(0);
  }
  if (!json.questions?.length) {
    db.logExtraction({ companyId, filename: fileName, status: 'skipped', skipReason: '无有效题目' });
    console.error('⚠️ 无有效题目');
    process.exit(0);
  }

  const cc = loadCompanies().find(c => c.id === companyId);

  if (!db.getCompany(companyId)) {
    db.upsertCompany({ id: companyId, name: cc?.name || companyId, aliases: cc?.aliases || [], searchKeywords: [] });
  }

  const rawPath = path.join(RAW_DIR, companyId, fileName);
  const raw = fs.existsSync(rawPath) ? parseRawMd(rawPath) : {};

  const interviewId = db.generateInterviewId(companyId);

  db.insertInterview({
    id: interviewId,
    companyId,
    source: raw.source || '未知',
    sourceUrl: raw.url || '',
    publishedAt: raw.publishedAt || null,
    date: raw.publishedAt?.slice(0, 7) || new Date().toISOString().slice(0, 7),
    level: json.level || 'P6',
    department: json.department,
    rounds: json.rounds || 1,
    result: json.result,
    experienceYears: json.experienceYears,
    education: json.education,
    questions: json.questions,
    jdHighlights: json.jdHighlights || [],
    rawFile: `raw/${companyId}/${fileName}`,
    title: raw.title || fileName,
  });

  // Auto-log to extraction_log
  db.logExtraction({
    companyId,
    filename: fileName,
    status: 'done',
    questionsExtracted: json.questions.length,
    interviewId,
  });

  db.refreshTopicStats();

  const total = db.getInterviewCount(companyId);
  console.log(JSON.stringify({ ok: true, questions: json.questions.length, level: json.level || 'P6', total }));
}

// ============ 命令：--merge-list ============

function cmdMergeList(companyFilter) {
  const allCompanies = loadCompanies();
  const companies = companyFilter && companyFilter !== 'all'
    ? [companyFilter]
    : allCompanies.map(c => c.id);

  const result = [];
  const d = db.getDb();

  for (const companyId of companies) {
    const rows = d.prepare(`
      SELECT q.module, q.topic, q.content, q.type, q.difficulty, q.company_id
      FROM questions q WHERE q.company_id = ?
    `).all(companyId);

    if (!rows.length) continue;

    const byModule = {};
    for (const r of rows) {
      if (!byModule[r.module]) byModule[r.module] = [];
      byModule[r.module].push(r);
    }

    for (const [mod, qs] of Object.entries(byModule)) {
      if (qs.length <= 1) continue;

      const input = qs.map((q, i) => ({
        i: i + 1, topic: q.topic, content: q.content, type: q.type,
        difficulty: q.difficulty, company: q.company_id || 'unknown'
      }));

      result.push({
        companyId,
        module: mod,
        questionCount: qs.length,
        systemPrompt: MERGE_SYSTEM_PROMPT,
        userPrompt: `模块: ${mod}\n题目列表:\n${JSON.stringify(input, null, 1)}`
      });
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

// ============ 命令：--merge-save ============

function cmdMergeSave(companyId, module) {
  let input = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    const mergedList = parseJson(input);
    if (!mergedList || !Array.isArray(mergedList)) {
      console.error('❌ 合并结果解析失败');
      process.exit(1);
    }

    db.saveMergedQuestions(companyId, module, mergedList);
    console.log(JSON.stringify({ ok: true, module, after: mergedList.length }));
  });
}

// ============ 命令：--hot-topics / --dry ============

function cmdHotTopics() {
  db.refreshTopicStats();
  console.error('📊 全局热点汇总已刷新（SQLite）');
}

function cmdDry() {
  let grandTotal = 0, grandPending = 0, grandSkipped = 0, grandDone = 0;
  for (const cc of loadCompanies()) {
    const rawDir = path.join(RAW_DIR, cc.id);
    if (!fs.existsSync(rawDir)) continue;
    const files = fs.readdirSync(rawDir).filter(f => f.endsWith('.md') && !f.startsWith('_'));
    const totalExtracted = db.getInterviewCount(cc.id);

    const pending = [];
    let skippedCount = 0;
    let doneCount = 0;
    for (const f of files) {
      // Check extraction_log table
      const status = db.isFileProcessed(cc.id, f);
      if (status === 'done') { doneCount++; continue; }
      if (status === 'skipped') { skippedCount++; continue; }
      // Fallback: check DB by source_url (for legacy data not yet in extraction_log)
      const raw = parseRawMd(path.join(rawDir, f));
      if (raw.url) {
        const processed = db.getProcessedUrls(cc.id);
        if (processed.has(raw.url)) { doneCount++; continue; }
      }
      pending.push(f);
    }
    if (files.length) {
      console.log(`${cc.name} (${cc.id}): ${files.length} 篇, ${pending.length} 待处理, ${doneCount} 已提取(DB:${totalExtracted}), ${skippedCount} 已跳过`);
      if (pending.length > 0) {
        pending.forEach(f => console.log(`  📄 ${f}`));
      }
    }
    grandTotal += files.length;
    grandPending += pending.length;
    grandSkipped += skippedCount;
    grandDone += doneCount;
  }
  console.log(`\n📊 总计: ${grandTotal} 篇, ${grandPending} 待处理, ${grandDone} 已完成, ${grandSkipped} 已跳过`);
}

// ============ 命令：--validate ============

function cmdSkip(companyId, fileName, reason) {
  db.logExtraction({ companyId, filename: fileName, status: 'skipped', skipReason: reason || '手动跳过' });
  console.log(JSON.stringify({ ok: true, status: 'skipped', reason: reason || '手动跳过' }));
}

function cmdExtractionStats() {
  const stats = db.getExtractionStats();
  console.log(`📊 提取进度（extraction_log）:`);
  console.log(`  总文件: ${stats.totalFiles}, 已完成: ${stats.totalDone}, 已跳过: ${stats.totalSkipped}, 总题目: ${stats.totalQuestions}`);
  console.log('');
  for (const c of stats.byCompany) {
    console.log(`  ${c.company_id}: ${c.total} 篇 (done=${c.done}, skipped=${c.skipped}, questions=${c.questionsExtracted})`);
  }
}


function cmdValidate(args) {
  let company = null, fix = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--company') company = args[++i];
    else if (args[i] === '--fix') fix = true;
  }
  const issues = db.validateQuestions({ company, fix });
  if (!issues.length) {
    console.log('✅ 数据校验通过，无问题。');
    return;
  }
  const byLevel = { ERROR: [], WARN: [], INFO: [] };
  for (const issue of issues) {
    (byLevel[issue.level] || byLevel.INFO).push(issue);
  }
  for (const level of ['ERROR', 'WARN', 'INFO']) {
    for (const issue of byLevel[level]) {
      const loc = issue.questionId ? `Q#${issue.questionId}` : issue.interviewId ? `IV#${issue.interviewId}` : '';
      const company = issue.company ? `[${issue.company}]` : '';
      console.log(`[${level}] ${company} ${loc} - ${issue.message}`);
    }
  }
  console.log(`\n合计: ${byLevel.ERROR.length} ERROR, ${byLevel.WARN.length} WARN, ${byLevel.INFO.length} INFO`);
}

// ============ 命令：--rebuild-relations / --update-relations ============

function cmdRebuildRelations() {
  console.error('🔄 开始全量关联重建...');
  const result = db.buildRelations({ rebuild: true });
  console.error(`✅ 关联重建完成，共 ${result.totalRelations} 条关联`);
}

function cmdUpdateRelations(args) {
  let since = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--since') since = args[++i];
  }
  console.error(`🔄 开始增量关联分析${since ? ` (since ${since})` : ''}...`);
  const result = db.buildRelations({ since });
  console.error(`✅ 关联分析完成，共 ${result.totalRelations} 条关联`);
}

// ============ Main ============

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd) {
  console.log(`
面经提取脚本 — Kiro 驱动模式（SQLite 版）

用法：
  node extract-raw.js --list [company|all]              列出待处理文件和 prompt（JSON）
  node extract-raw.js --save <company> <file>           从 stdin 读取提取结果并保存
  node extract-raw.js --save <company> <file> --file F  从文件读取提取结果并保存
  node extract-raw.js --skip <company> <file> [reason]  标记文件为跳过
  node extract-raw.js --merge-list [company|all]        列出待合并数据和 prompt（JSON）
  node extract-raw.js --merge-save <company> <module>   从 stdin 读取合并结果并保存
  node extract-raw.js --hot-topics                      更新全局热点汇总
  node extract-raw.js --dry                             预览待处理文件
  node extract-raw.js --extraction-stats                查看提取进度统计
  node extract-raw.js --validate [--company X] [--fix]  数据质量校验
  node extract-raw.js --rebuild-relations               全量关联重建
  node extract-raw.js --update-relations [--since DATE] 增量关联分析

公司: 从 DB 动态读取（运行后自动列出）
`);
} else if (cmd === '--list') {
  cmdList(args[1]);
} else if (cmd === '--save') {
  // 支持 --file 参数：--save <company> <file> --file <jsonFile>
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    cmdSaveFromFile(args[1], args[2], args[fileIdx + 1]);
  } else {
    cmdSave(args[1], args[2]);
  }
} else if (cmd === '--merge-list') {
  cmdMergeList(args[1]);
} else if (cmd === '--merge-save') {
  cmdMergeSave(args[1], args[2]);
} else if (cmd === '--hot-topics') {
  cmdHotTopics();
} else if (cmd === '--dry') {
  cmdDry();
} else if (cmd === '--skip') {
  cmdSkip(args[1], args[2], args.slice(3).join(' '));
} else if (cmd === '--extraction-stats') {
  cmdExtractionStats();
} else if (cmd === '--validate') {
  cmdValidate(args.slice(1));
} else if (cmd === '--rebuild-relations') {
  cmdRebuildRelations();
} else if (cmd === '--update-relations') {
  cmdUpdateRelations(args.slice(1));
} else {
  console.error(`未知命令: ${cmd}`);
  process.exit(1);
}

db.closeDb();
