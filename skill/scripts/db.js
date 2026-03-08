#!/usr/bin/env node
/**
 * 面经数据库 — SQLite 存储层 v2
 *
 * 核心表：
 *   companies                  公司基础信息
 *   interviews                 面试记录（一篇面经 = 一条）
 *   questions                  面试题目（一道题 = 一条）
 *   question_knowledge_points  题目-知识点关联
 *   question_follow_ups        追问链
 *   jd_highlights              JD 亮点
 *   topic_stats                热点聚合（物化视图，替代旧 hot_topics + merged_questions）
 *   company_module_profile     公司×模块画像（AI 出题参考）
 *   questions_fts              FTS5 全文搜索虚拟表
 *   crawled_urls               采集 URL 去重
 *   meta                       元数据 KV
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DB_DIR, 'interview-intel.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    -- ============================================================
    -- companies
    -- ============================================================
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      aliases TEXT,              -- JSON array
      search_keywords TEXT,      -- JSON array
      last_updated TEXT,
      total_interviews INTEGER DEFAULT 0
    );

    -- ============================================================
    -- interviews（增加 title/raw_file/result/experience_years/tags
    --             + position/recruit_type/content_hash/pushed_at/
    --               contributor_id/trust_level/source_type/status）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS interviews (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      source TEXT,               -- xiaohongshu / nowcoder / juejin
      source_url TEXT,
      title TEXT,                -- 面经标题
      raw_file TEXT,             -- raw/ 下的文件路径（溯源）
      published_at TEXT,         -- 原文发布时间
      date TEXT,                 -- 面试实际日期
      level TEXT,                -- P5/P6/P7
      department TEXT,
      rounds INTEGER DEFAULT 1,
      result TEXT,               -- pass/fail/unknown
      experience_years TEXT,     -- 候选人经验（如 "3-5"）
      tags TEXT,                 -- JSON array
      position TEXT,             -- 岗位方向：java-backend/go-backend/frontend/...
      recruit_type TEXT,         -- 招聘类型：social/campus/intern
      content_hash TEXT,         -- SHA256 去重
      pushed_at TEXT,            -- 推送到远程站的时间
      contributor_id INTEGER,    -- 贡献者 user_id（本地采集为 null）
      trust_level TEXT DEFAULT 'new',  -- new/trusted/flagged
      source_type TEXT DEFAULT 'local', -- local/contributed
      status TEXT DEFAULT 'active',    -- active/hidden/deleted
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id)
    );

    -- ============================================================
    -- interview_contributors（同一面经多人贡献记录）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS interview_contributors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interview_id TEXT NOT NULL,
      contributor_id INTEGER NOT NULL,
      contributed_at TEXT DEFAULT (datetime('now')),
      UNIQUE(interview_id, contributor_id),
      FOREIGN KEY (interview_id) REFERENCES interviews(id)
    );

    -- ============================================================
    -- questions（增加 answer_hint/round/sort_order/published_at
    --            + position/recruit_type 冗余自 interviews）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interview_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      module TEXT NOT NULL,
      topic TEXT NOT NULL,        -- 归一化主题
      type TEXT,                  -- 简答/场景设计/代码题/系统设计/八股/追问链
      difficulty TEXT,            -- P5/P6/P7
      content TEXT,               -- 原始题目文本
      answer_hint TEXT,           -- 参考答案要点（AI 出题锚点）
      round INTEGER,              -- 第几轮面试
      sort_order INTEGER DEFAULT 0, -- 题目在该面试中的顺序
      published_at TEXT,          -- 冗余自 interviews
      position TEXT,              -- 冗余自 interviews.position
      recruit_type TEXT,          -- 冗余自 interviews.recruit_type
      FOREIGN KEY (interview_id) REFERENCES interviews(id),
      FOREIGN KEY (company_id) REFERENCES companies(id)
    );

    -- ============================================================
    -- question_knowledge_points
    -- ============================================================
    CREATE TABLE IF NOT EXISTS question_knowledge_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      knowledge_point TEXT NOT NULL,
      FOREIGN KEY (question_id) REFERENCES questions(id)
    );

    -- ============================================================
    -- question_follow_ups
    -- ============================================================
    CREATE TABLE IF NOT EXISTS question_follow_ups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      follow_up TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (question_id) REFERENCES questions(id)
    );

    -- ============================================================
    -- jd_highlights
    -- ============================================================
    CREATE TABLE IF NOT EXISTS jd_highlights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interview_id TEXT NOT NULL,
      highlight TEXT NOT NULL,
      FOREIGN KEY (interview_id) REFERENCES interviews(id)
    );

    -- ============================================================
    -- topic_stats（替代旧 hot_topics + merged_questions）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS topic_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module TEXT NOT NULL,
      topic TEXT NOT NULL,
      frequency INTEGER DEFAULT 1,
      company_count INTEGER DEFAULT 1,
      companies TEXT,              -- JSON array
      difficulty_dist TEXT,        -- JSON {"P5":2,"P6":5,"P7":1}
      avg_round REAL,
      latest_seen TEXT,
      earliest_seen TEXT,
      trend TEXT,                  -- rising/stable/declining
      sample_questions TEXT,       -- JSON array [{content,company,followUps}]
      sample_follow_ups TEXT,      -- JSON array
      knowledge_points TEXT,       -- JSON array
      last_updated TEXT,
      UNIQUE(module, topic)
    );

    -- ============================================================
    -- company_module_profile（公司×模块画像，AI 出题参考）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS company_module_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL,
      module TEXT NOT NULL,
      question_count INTEGER DEFAULT 0,
      top_topics TEXT,             -- JSON array
      difficulty_dist TEXT,        -- JSON
      common_follow_ups TEXT,      -- JSON array
      style_notes TEXT,            -- 面试风格备注
      last_updated TEXT,
      UNIQUE(company_id, module),
      FOREIGN KEY (company_id) REFERENCES companies(id)
    );

    -- ============================================================
    -- meta
    -- ============================================================
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- ============================================================
    -- crawled_urls
    -- ============================================================
    CREATE TABLE IF NOT EXISTS crawled_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL,
      url TEXT NOT NULL,
      source TEXT,
      title TEXT,
      published_at TEXT,
      crawled_at TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'raw',
      UNIQUE(url)
    );

    -- ============================================================
    -- 索引
    -- ============================================================
    CREATE INDEX IF NOT EXISTS idx_questions_module ON questions(module);
    CREATE INDEX IF NOT EXISTS idx_questions_company ON questions(company_id);
    CREATE INDEX IF NOT EXISTS idx_questions_difficulty ON questions(difficulty);
    CREATE INDEX IF NOT EXISTS idx_questions_topic ON questions(topic);
    CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(type);
    CREATE INDEX IF NOT EXISTS idx_questions_published ON questions(published_at);
    CREATE INDEX IF NOT EXISTS idx_questions_round ON questions(round);
    CREATE INDEX IF NOT EXISTS idx_interviews_company ON interviews(company_id);
    CREATE INDEX IF NOT EXISTS idx_interviews_date ON interviews(published_at);
    CREATE INDEX IF NOT EXISTS idx_interviews_level ON interviews(level);
    CREATE INDEX IF NOT EXISTS idx_interviews_result ON interviews(result);
    CREATE INDEX IF NOT EXISTS idx_kp_question ON question_knowledge_points(question_id);
    CREATE INDEX IF NOT EXISTS idx_kp_point ON question_knowledge_points(knowledge_point);
    CREATE INDEX IF NOT EXISTS idx_topic_stats_module ON topic_stats(module);
    CREATE INDEX IF NOT EXISTS idx_topic_stats_freq ON topic_stats(frequency DESC);
    CREATE INDEX IF NOT EXISTS idx_topic_stats_trend ON topic_stats(trend);
    CREATE INDEX IF NOT EXISTS idx_company_profile ON company_module_profile(company_id, module);
    CREATE INDEX IF NOT EXISTS idx_crawled_urls_company ON crawled_urls(company_id);
    CREATE INDEX IF NOT EXISTS idx_crawled_urls_url ON crawled_urls(url);
  `);

  // ============================================================
  // Schema 升级：新增字段（ALTER TABLE + try/catch 忽略已存在列）
  // ============================================================
  const alterStmts = [
    'ALTER TABLE questions ADD COLUMN raw_content TEXT',
    'ALTER TABLE questions ADD COLUMN question_style TEXT',
    'ALTER TABLE questions ADD COLUMN depth_level TEXT',
    'ALTER TABLE question_follow_ups ADD COLUMN parent_id INTEGER',
    'ALTER TABLE question_follow_ups ADD COLUMN depth INTEGER DEFAULT 0',
    'ALTER TABLE topic_stats ADD COLUMN style_dist TEXT',
    'ALTER TABLE topic_stats ADD COLUMN timeline TEXT',
    'ALTER TABLE interviews ADD COLUMN education TEXT',
    // 开源版新增字段
    'ALTER TABLE interviews ADD COLUMN position TEXT',
    'ALTER TABLE interviews ADD COLUMN recruit_type TEXT',
    'ALTER TABLE interviews ADD COLUMN content_hash TEXT',
    'ALTER TABLE interviews ADD COLUMN pushed_at TEXT',
    'ALTER TABLE interviews ADD COLUMN contributor_id INTEGER',
    "ALTER TABLE interviews ADD COLUMN trust_level TEXT DEFAULT 'new'",
    "ALTER TABLE interviews ADD COLUMN source_type TEXT DEFAULT 'local'",
    "ALTER TABLE interviews ADD COLUMN status TEXT DEFAULT 'active'",
    'ALTER TABLE questions ADD COLUMN position TEXT',
    'ALTER TABLE questions ADD COLUMN recruit_type TEXT',
  ];
  for (const stmt of alterStmts) {
    try { db.exec(stmt); } catch (_) { /* 列已存在，忽略 */ }
  }

  // 新建 question_relations 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS question_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id_a INTEGER NOT NULL,
      question_id_b INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      note TEXT,
      FOREIGN KEY (question_id_a) REFERENCES questions(id),
      FOREIGN KEY (question_id_b) REFERENCES questions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_questions_style ON questions(question_style);
    CREATE INDEX IF NOT EXISTS idx_questions_depth ON questions(depth_level);
    CREATE INDEX IF NOT EXISTS idx_relations_a ON question_relations(question_id_a);
    CREATE INDEX IF NOT EXISTS idx_relations_b ON question_relations(question_id_b);
    CREATE INDEX IF NOT EXISTS idx_relations_type ON question_relations(relation_type);
  `);

  // ============================================================
  // interview_contributors + 新索引
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS interview_contributors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interview_id TEXT NOT NULL,
      contributor_id INTEGER NOT NULL,
      contributed_at TEXT DEFAULT (datetime('now')),
      UNIQUE(interview_id, contributor_id),
      FOREIGN KEY (interview_id) REFERENCES interviews(id)
    );
    CREATE INDEX IF NOT EXISTS idx_interviews_position ON interviews(position);
    CREATE INDEX IF NOT EXISTS idx_interviews_recruit_type ON interviews(recruit_type);
    CREATE INDEX IF NOT EXISTS idx_interviews_content_hash ON interviews(content_hash);
    CREATE INDEX IF NOT EXISTS idx_interviews_trust_level ON interviews(trust_level);
    CREATE INDEX IF NOT EXISTS idx_interviews_pushed_at ON interviews(pushed_at);
    CREATE INDEX IF NOT EXISTS idx_questions_position ON questions(position);
    CREATE INDEX IF NOT EXISTS idx_questions_recruit_type ON questions(recruit_type);
    CREATE INDEX IF NOT EXISTS idx_contributors_interview ON interview_contributors(interview_id);
    CREATE INDEX IF NOT EXISTS idx_contributors_user ON interview_contributors(contributor_id);
  `);

  // ============================================================
  // extraction_log（替代 extraction-progress.json）
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      status TEXT NOT NULL,           -- done / skipped
      questions_extracted INTEGER DEFAULT 0,
      skip_reason TEXT,
      multi_company INTEGER DEFAULT 0,
      split_to TEXT,                  -- JSON array of companyIds
      questions_by_company TEXT,      -- JSON {"bilibili": 5, "kuaishou": 12}
      interview_id TEXT,              -- FK to interviews.id (for done)
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, filename)
    );
    CREATE INDEX IF NOT EXISTS idx_extraction_log_company ON extraction_log(company_id);
    CREATE INDEX IF NOT EXISTS idx_extraction_log_status ON extraction_log(status);
    CREATE INDEX IF NOT EXISTS idx_extraction_log_filename ON extraction_log(filename);
  `);

  // FTS5 全文搜索（单独 exec，避免与普通 DDL 混在一起）
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS questions_fts USING fts5(
        topic, content, answer_hint,
        content='questions',
        content_rowid='id'
      );
    `);
  } catch (e) {
    // FTS5 不可用时静默降级
    if (!e.message.includes('already exists')) {
      console.error('FTS5 初始化跳过:', e.message);
    }
  }
}

// ============ FTS 同步辅助 ============

function syncFts(questionId, topic, content, answerHint) {
  const db = getDb();
  try {
    db.prepare(`INSERT INTO questions_fts(rowid, topic, content, answer_hint) VALUES (?, ?, ?, ?)`)
      .run(questionId, topic || '', content || '', answerHint || '');
  } catch (_) { /* FTS 不可用时静默 */ }
}

function rebuildFts() {
  const db = getDb();
  try {
    db.exec(`DELETE FROM questions_fts`);
    db.exec(`INSERT INTO questions_fts(rowid, topic, content, answer_hint) SELECT id, topic, content, answer_hint FROM questions`);
  } catch (_) { /* FTS 不可用时静默 */ }
}

// ============ 公司 CRUD ============

function upsertCompany(company) {
  const db = getDb();
  db.prepare(`
    INSERT INTO companies (id, name, aliases, search_keywords, last_updated, total_interviews)
    VALUES (@id, @name, @aliases, @searchKeywords, @lastUpdated, @totalInterviews)
    ON CONFLICT(id) DO UPDATE SET
      name = @name, aliases = @aliases, search_keywords = @searchKeywords,
      last_updated = @lastUpdated, total_interviews = @totalInterviews
  `).run({
    id: company.id,
    name: company.name,
    aliases: JSON.stringify(company.aliases || []),
    searchKeywords: JSON.stringify(company.searchKeywords || []),
    lastUpdated: company.lastUpdated || new Date().toISOString().split('T')[0],
    totalInterviews: company.totalInterviews || 0,
  });
}

function getCompany(companyId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  if (!row) return null;
  return { ...row, aliases: JSON.parse(row.aliases || '[]'), searchKeywords: JSON.parse(row.search_keywords || '[]') };
}

function updateCompanyStats(companyId) {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as cnt FROM interviews WHERE company_id = ?').get(companyId);
  db.prepare('UPDATE companies SET total_interviews = ?, last_updated = ? WHERE id = ?')
    .run(count.cnt, new Date().toISOString().split('T')[0], companyId);
}

// ============ 面试记录 CRUD ============

function insertInterview(interview) {
  const db = getDb();
  const insertIv = db.prepare(`
    INSERT OR IGNORE INTO interviews (id, company_id, source, source_url, title, raw_file, published_at, date, level, department, rounds, result, experience_years, education, tags, position, recruit_type, content_hash, source_type, trust_level)
    VALUES (@id, @companyId, @source, @sourceUrl, @title, @rawFile, @publishedAt, @date, @level, @department, @rounds, @result, @experienceYears, @education, @tags, @position, @recruitType, @contentHash, @sourceType, @trustLevel)
  `);
  const insertQ = db.prepare(`
    INSERT INTO questions (interview_id, company_id, module, topic, type, difficulty, content, answer_hint, raw_content, question_style, depth_level, round, sort_order, published_at, position, recruit_type)
    VALUES (@interviewId, @companyId, @module, @topic, @type, @difficulty, @content, @answerHint, @rawContent, @questionStyle, @depthLevel, @round, @sortOrder, @publishedAt, @position, @recruitType)
  `);
  const insertKp = db.prepare(`
    INSERT INTO question_knowledge_points (question_id, knowledge_point) VALUES (?, ?)
  `);
  const insertFu = db.prepare(`
    INSERT INTO question_follow_ups (question_id, follow_up, sort_order, parent_id, depth) VALUES (?, ?, ?, ?, ?)
  `);
  const insertJd = db.prepare(`
    INSERT INTO jd_highlights (interview_id, highlight) VALUES (?, ?)
  `);

  const txn = db.transaction(() => {
    insertIv.run({
      id: interview.id,
      companyId: interview.companyId,
      source: interview.source || null,
      sourceUrl: interview.sourceUrl || null,
      title: interview.title || null,
      rawFile: interview.rawFile || null,
      publishedAt: interview.publishedAt || null,
      date: interview.date || null,
      level: interview.level || 'P6',
      department: interview.department || null,
      rounds: interview.rounds || 1,
      result: interview.result || 'unknown',
      experienceYears: interview.experienceYears || null,
      education: interview.education || null,
      tags: JSON.stringify(interview.tags || []),
      position: interview.position || null,
      recruitType: interview.recruitType || null,
      contentHash: interview.contentHash || null,
      sourceType: interview.sourceType || 'local',
      trustLevel: interview.trustLevel || 'new',
    });

    const pubAt = interview.publishedAt || null;
    let sortIdx = 0;
    for (const q of interview.questions || []) {
      const result = insertQ.run({
        interviewId: interview.id,
        companyId: interview.companyId,
        module: q.module,
        topic: q.topic,
        type: q.type || null,
        difficulty: q.difficulty || null,
        content: q.content || null,
        answerHint: q.answerHint || null,
        rawContent: q.rawContent || null,
        questionStyle: q.questionStyle || null,
        depthLevel: q.depthLevel || null,
        round: q.round || null,
        sortOrder: q.sortOrder != null ? q.sortOrder : sortIdx++,
        publishedAt: pubAt,
        position: interview.position || null,
        recruitType: interview.recruitType || null,
      });
      const qId = Number(result.lastInsertRowid);

      for (const kp of q.knowledgePoints || []) {
        insertKp.run(qId, kp);
      }

      // followUps: 兼容旧格式（字符串数组）和新格式（对象数组 [{content, parentIndex, depth}]）
      const fuIds = [];
      for (let i = 0; i < (q.followUps || []).length; i++) {
        const fu = q.followUps[i];
        const isObject = fu && typeof fu === 'object';
        const content = isObject ? fu.content : fu;
        const depth = isObject ? (fu.depth || 0) : 0;
        const parentIdx = isObject ? fu.parentIndex : null;
        const parentId = parentIdx != null && parentIdx < fuIds.length ? fuIds[parentIdx] : null;

        const fuResult = insertFu.run(qId, content, i, parentId, depth);
        fuIds.push(Number(fuResult.lastInsertRowid));
      }

      syncFts(qId, q.topic, q.content, q.answerHint);
    }

    for (const jd of interview.jdHighlights || []) {
      insertJd.run(interview.id, jd);
    }

    updateCompanyStats(interview.companyId);
  });

  txn();
}

function getProcessedUrls(companyId) {
  const db = getDb();
  const rows = db.prepare('SELECT source_url FROM interviews WHERE company_id = ? AND source_url IS NOT NULL')
    .all(companyId);
  return new Set(rows.map(r => r.source_url));
}

function getInterviewCount(companyId) {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) as cnt FROM interviews WHERE company_id = ?').get(companyId).cnt;
}

function generateInterviewId(companyId) {
  const count = getInterviewCount(companyId);
  return `${companyId}-${String(count + 1).padStart(3, '0')}`;
}

// ============ 查询引擎 ============

/**
 * 通用题目查询，支持：
 *   module, company, difficulty, type, keyword (LIKE),
 *   knowledgePoints (数组), round, publishedAfter, publishedBefore,
 *   result (pass/fail), experienceYears, fts (全文搜索),
 *   limit, offset, orderBy
 */
function queryQuestions(filters) {
  const db = getDb();

  // FTS 搜索走单独路径
  if (filters.fts) {
    return ftsSearch(filters.fts, filters.limit || 20);
  }

  const conditions = [];
  const params = {};

  if (filters.module) {
    conditions.push('q.module = @module');
    params.module = filters.module;
  }
  if (filters.company) {
    conditions.push('q.company_id = @company');
    params.company = filters.company;
  }
  if (filters.difficulty) {
    conditions.push('q.difficulty = @difficulty');
    params.difficulty = filters.difficulty;
  }
  if (filters.type) {
    conditions.push('q.type = @type');
    params.type = filters.type;
  }
  if (filters.keyword) {
    conditions.push('(q.topic LIKE @keyword OR q.content LIKE @keyword)');
    params.keyword = `%${filters.keyword}%`;
  }
  if (filters.round) {
    conditions.push('q.round = @round');
    params.round = filters.round;
  }
  if (filters.publishedAfter) {
    conditions.push('q.published_at >= @publishedAfter');
    params.publishedAfter = filters.publishedAfter;
  }
  if (filters.publishedBefore) {
    conditions.push('q.published_at <= @publishedBefore');
    params.publishedBefore = filters.publishedBefore;
  }
  if (filters.result) {
    conditions.push('i.result = @result');
    params.result = filters.result;
  }
  if (filters.experienceYears) {
    conditions.push('i.experience_years = @experienceYears');
    params.experienceYears = filters.experienceYears;
  }
  if (filters.style) {
    conditions.push('q.question_style = @style');
    params.style = filters.style;
  }
  if (filters.depth) {
    conditions.push('q.depth_level = @depth');
    params.depth = filters.depth;
  }
  if (filters.position) {
    conditions.push('q.position = @position');
    params.position = filters.position;
  }
  if (filters.recruitType) {
    conditions.push('q.recruit_type = @recruitType');
    params.recruitType = filters.recruitType;
  }

  let kpJoin = '';
  if (filters.knowledgePoints?.length) {
    kpJoin = 'INNER JOIN question_knowledge_points kp ON kp.question_id = q.id';
    const kpConds = filters.knowledgePoints.map((kp, i) => {
      params[`kp${i}`] = `%${kp}%`;
      return `kp.knowledge_point LIKE @kp${i}`;
    });
    conditions.push(`(${kpConds.join(' OR ')})`);
  }

  // 始终 JOIN interviews 以返回溯源信息
  const ivJoin = 'JOIN interviews i ON i.id = q.interview_id';

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit || 20;
  const offset = filters.offset || 0;
  const orderBy = filters.orderBy || 'q.published_at DESC, q.sort_order';

  const sql = `
    SELECT DISTINCT q.id, q.interview_id, q.company_id, q.module, q.topic, q.type,
           q.difficulty, q.content, q.answer_hint, q.raw_content, q.question_style, q.depth_level,
           q.round, q.sort_order, q.published_at,
           c.name as company_name,
           i.title as interview_title, i.source_url, i.raw_file,
           i.published_at as interview_published_at, i.level as interview_level,
           i.rounds as interview_rounds, i.result as interview_result,
           i.experience_years
    FROM questions q
    JOIN companies c ON c.id = q.company_id
    ${ivJoin}
    ${kpJoin}
    ${where}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}
  `;

  const rows = db.prepare(sql).all(params);

  const stmtKp = db.prepare('SELECT knowledge_point FROM question_knowledge_points WHERE question_id = ?');
  const stmtFu = db.prepare('SELECT id, follow_up, sort_order, parent_id, depth FROM question_follow_ups WHERE question_id = ? ORDER BY sort_order');

  return rows.map(r => ({
    id: r.id,
    interview_id: r.interview_id,
    company_id: r.company_id,
    module: r.module,
    topic: r.topic,
    type: r.type,
    difficulty: r.difficulty,
    content: r.content,
    answer_hint: r.answer_hint,
    raw_content: r.raw_content,
    question_style: r.question_style,
    depth_level: r.depth_level,
    round: r.round,
    sort_order: r.sort_order,
    published_at: r.published_at,
    company_name: r.company_name,
    knowledgePoints: stmtKp.all(r.id).map(x => x.knowledge_point),
    followUps: stmtFu.all(r.id).map(x => ({
      id: x.id, content: x.follow_up, sortOrder: x.sort_order, parentId: x.parent_id, depth: x.depth,
    })),
    trace: {
      interview_id: r.interview_id,
      title: r.interview_title,
      company_id: r.company_id,
      company_name: r.company_name,
      source_url: r.source_url,
      raw_file: r.raw_file,
      published_at: r.interview_published_at,
      level: r.interview_level,
      rounds: r.interview_rounds,
      result: r.interview_result,
      experience_years: r.experience_years,
    },
  }));
}

/**
 * FTS5 全文搜索
 */
function ftsSearch(query, limit = 20) {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT q.id, q.interview_id, q.company_id, q.module, q.topic, q.type,
             q.difficulty, q.content, q.answer_hint, q.round, q.published_at,
             c.name as company_name,
             rank
      FROM questions_fts fts
      JOIN questions q ON q.id = fts.rowid
      JOIN companies c ON c.id = q.company_id
      WHERE questions_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit);

    const stmtKp = db.prepare('SELECT knowledge_point FROM question_knowledge_points WHERE question_id = ?');
    const stmtFu = db.prepare('SELECT follow_up FROM question_follow_ups WHERE question_id = ? ORDER BY sort_order');

    return rows.map(r => ({
      ...r,
      knowledgePoints: stmtKp.all(r.id).map(x => x.knowledge_point),
      followUps: stmtFu.all(r.id).map(x => x.follow_up),
    }));
  } catch (_) {
    // FTS 不可用，降级到 LIKE
    return queryQuestions({ keyword: query, limit });
  }
}

// ============ 热点聚合（topic_stats） ============

/**
 * 刷新 topic_stats 物化视图
 * 替代旧的 refreshHotTopics + saveMergedQuestions
 */
function refreshTopicStats() {
  const db = getDb();
  const now = new Date().toISOString().split('T')[0];
  const threeMonthsAgo = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];

  db.prepare('DELETE FROM topic_stats').run();

  // 基础聚合
  const rows = db.prepare(`
    SELECT q.module, q.topic,
           COUNT(*) as frequency,
           COUNT(DISTINCT q.company_id) as company_count,
           GROUP_CONCAT(DISTINCT q.company_id) as companies,
           AVG(q.round) as avg_round,
           MAX(q.published_at) as latest_seen,
           MIN(q.published_at) as earliest_seen
    FROM questions q
    GROUP BY q.module, q.topic
  `).all();

  const insertStmt = db.prepare(`
    INSERT INTO topic_stats (module, topic, frequency, company_count, companies, difficulty_dist,
      avg_round, latest_seen, earliest_seen, trend, sample_questions, sample_follow_ups,
      knowledge_points, style_dist, timeline, last_updated)
    VALUES (@module, @topic, @frequency, @companyCount, @companies, @difficultyDist,
      @avgRound, @latestSeen, @earliestSeen, @trend, @sampleQuestions, @sampleFollowUps,
      @knowledgePoints, @styleDist, @timeline, @lastUpdated)
  `);

  // 难度分布查询
  const diffStmt = db.prepare(`
    SELECT difficulty, COUNT(*) as cnt FROM questions WHERE module = ? AND topic = ? GROUP BY difficulty
  `);

  // 样本题目
  const sampleStmt = db.prepare(`
    SELECT q.content, q.company_id, q.difficulty FROM questions q
    WHERE q.module = ? AND q.topic = ? AND q.content IS NOT NULL
    ORDER BY q.published_at DESC LIMIT 3
  `);

  // 追问合集
  const fuStmt = db.prepare(`
    SELECT DISTINCT fu.follow_up FROM question_follow_ups fu
    JOIN questions q ON q.id = fu.question_id
    WHERE q.module = ? AND q.topic = ?
    ORDER BY fu.sort_order LIMIT 8
  `);

  // 知识点合集
  const kpStmt = db.prepare(`
    SELECT DISTINCT kp.knowledge_point FROM question_knowledge_points kp
    JOIN questions q ON q.id = kp.question_id
    WHERE q.module = ? AND q.topic = ?
    LIMIT 10
  `);

  // 趋势：近3月 vs 之前
  const recentStmt = db.prepare(`
    SELECT COUNT(*) as cnt FROM questions WHERE module = ? AND topic = ? AND published_at >= ?
  `);
  const olderStmt = db.prepare(`
    SELECT COUNT(*) as cnt FROM questions WHERE module = ? AND topic = ? AND (published_at < ? OR published_at IS NULL)
  `);

  // question_style 分布
  const styleStmt = db.prepare(`
    SELECT question_style, COUNT(*) as cnt FROM questions
    WHERE module = ? AND topic = ? AND question_style IS NOT NULL
    GROUP BY question_style
  `);

  // 时间线（按季度）
  const timelineStmt = db.prepare(`
    SELECT substr(published_at, 1, 4) || '-Q' || ((CAST(substr(published_at, 6, 2) AS INTEGER) - 1) / 3 + 1) as period,
           COUNT(*) as count
    FROM questions
    WHERE module = ? AND topic = ? AND published_at IS NOT NULL
    GROUP BY period ORDER BY period
  `);

  const txn = db.transaction(() => {
    for (const r of rows) {
      // 难度分布
      const diffRows = diffStmt.all(r.module, r.topic);
      const diffDist = {};
      for (const d of diffRows) diffDist[d.difficulty || 'unknown'] = d.cnt;

      // 样本
      const samples = sampleStmt.all(r.module, r.topic).map(s => ({
        content: s.content, company: s.company_id, difficulty: s.difficulty,
      }));

      // 追问
      const followUps = fuStmt.all(r.module, r.topic).map(x => x.follow_up);

      // 知识点
      const kps = kpStmt.all(r.module, r.topic).map(x => x.knowledge_point);

      // 趋势
      const recent = recentStmt.get(r.module, r.topic, threeMonthsAgo).cnt;
      const older = olderStmt.get(r.module, r.topic, threeMonthsAgo).cnt;
      let trend = 'stable';
      if (older === 0 && recent > 0) trend = 'rising';
      else if (older > 0 && recent > older) trend = 'rising';
      else if (older > 0 && recent < older * 0.5) trend = 'declining';

      // question_style 分布
      const styleRows = styleStmt.all(r.module, r.topic);
      const styleDist = {};
      for (const s of styleRows) styleDist[s.question_style] = s.cnt;

      // 时间线
      const timelineRows = timelineStmt.all(r.module, r.topic);

      insertStmt.run({
        module: r.module,
        topic: r.topic,
        frequency: r.frequency,
        companyCount: r.company_count,
        companies: JSON.stringify(r.companies ? r.companies.split(',') : []),
        difficultyDist: JSON.stringify(diffDist),
        avgRound: r.avg_round,
        latestSeen: r.latest_seen,
        earliestSeen: r.earliest_seen,
        trend,
        sampleQuestions: JSON.stringify(samples),
        sampleFollowUps: JSON.stringify(followUps),
        knowledgePoints: JSON.stringify(kps),
        styleDist: JSON.stringify(styleDist),
        timeline: JSON.stringify(timelineRows),
        lastUpdated: now,
      });
    }
  });
  txn();

  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('topic_stats_updated', ?)`)
    .run(now);

  // 同步刷新公司模块画像
  refreshCompanyProfiles();
}

// 兼容旧接口
const refreshHotTopics = refreshTopicStats;

// ============ 公司模块画像 ============

function refreshCompanyProfiles() {
  const db = getDb();
  const now = new Date().toISOString().split('T')[0];

  db.prepare('DELETE FROM company_module_profile').run();

  const rows = db.prepare(`
    SELECT company_id, module, COUNT(*) as cnt
    FROM questions GROUP BY company_id, module
  `).all();

  const insertStmt = db.prepare(`
    INSERT INTO company_module_profile (company_id, module, question_count, top_topics, difficulty_dist, common_follow_ups, style_notes, last_updated)
    VALUES (@companyId, @module, @questionCount, @topTopics, @difficultyDist, @commonFollowUps, @styleNotes, @lastUpdated)
  `);

  const topTopicsStmt = db.prepare(`
    SELECT topic, COUNT(*) as cnt FROM questions WHERE company_id = ? AND module = ?
    GROUP BY topic ORDER BY cnt DESC LIMIT 5
  `);
  const diffStmt = db.prepare(`
    SELECT difficulty, COUNT(*) as cnt FROM questions WHERE company_id = ? AND module = ?
    GROUP BY difficulty
  `);
  const fuStmt = db.prepare(`
    SELECT DISTINCT fu.follow_up FROM question_follow_ups fu
    JOIN questions q ON q.id = fu.question_id
    WHERE q.company_id = ? AND q.module = ?
    ORDER BY fu.sort_order LIMIT 6
  `);

  const txn = db.transaction(() => {
    for (const r of rows) {
      const tops = topTopicsStmt.all(r.company_id, r.module).map(t => `${t.topic}(${t.cnt})`);
      const diffs = diffStmt.all(r.company_id, r.module);
      const diffDist = {};
      for (const d of diffs) diffDist[d.difficulty || 'unknown'] = d.cnt;
      const fus = fuStmt.all(r.company_id, r.module).map(x => x.follow_up);

      insertStmt.run({
        companyId: r.company_id,
        module: r.module,
        questionCount: r.cnt,
        topTopics: JSON.stringify(tops),
        difficultyDist: JSON.stringify(diffDist),
        commonFollowUps: JSON.stringify(fus),
        styleNotes: null,
        lastUpdated: now,
      });
    }
  });
  txn();
}

// ============ 查询接口 ============

function getHotTopics(moduleFilter, companyFilter) {
  const db = getDb();

  // 按公司过滤时，直接从 questions 表实时聚合
  if (companyFilter) {
    const params = [companyFilter];
    let whereExtra = '';
    if (moduleFilter) { whereExtra = ' AND q.module = ?'; params.push(moduleFilter); }

    const rows = db.prepare(`
      SELECT q.module, q.topic,
             COUNT(*) as frequency,
             GROUP_CONCAT(DISTINCT q.company_id) as companies
      FROM questions q
      WHERE q.company_id = ?${whereExtra}
      GROUP BY q.module, q.topic
      ORDER BY q.module, frequency DESC
    `).all(...params);

    const kpStmt = db.prepare(`
      SELECT DISTINCT kp.knowledge_point FROM question_knowledge_points kp
      JOIN questions q ON q.id = kp.question_id
      WHERE q.company_id = ? AND q.module = ? AND q.topic = ? LIMIT 8
    `);

    const result = {};
    for (const r of rows) {
      if (!result[r.module]) {
        result[r.module] = { totalMentions: 0, byCompany: {}, topQuestions: [] };
      }
      result[r.module].totalMentions += r.frequency;
      const kps = kpStmt.all(companyFilter, r.module, r.topic).map(x => x.knowledge_point);
      result[r.module].topQuestions.push({
        topic: r.topic,
        frequency: r.frequency,
        companyCount: 1,
        companies: [companyFilter],
        knowledgePoints: kps,
      });
    }
    return result;
  }

  // 无公司过滤时，走 topic_stats 全局表（原逻辑）
  let rows;
  if (moduleFilter) {
    rows = db.prepare('SELECT * FROM topic_stats WHERE module = ? ORDER BY frequency DESC').all(moduleFilter);
  } else {
    rows = db.prepare('SELECT * FROM topic_stats ORDER BY module, frequency DESC').all();
  }

  const result = {};
  for (const r of rows) {
    if (!result[r.module]) {
      result[r.module] = { totalMentions: 0, byCompany: {}, topQuestions: [] };
    }
    result[r.module].totalMentions += r.frequency;
    result[r.module].topQuestions.push({
      topic: r.topic,
      frequency: r.frequency,
      companyCount: r.company_count,
      companies: JSON.parse(r.companies || '[]'),
      trend: r.trend,
      difficultyDist: JSON.parse(r.difficulty_dist || '{}'),
      sampleFollowUps: JSON.parse(r.sample_follow_ups || '[]'),
      knowledgePoints: JSON.parse(r.knowledge_points || '[]'),
    });
  }
  return result;
}

function getTopicDetail(module, topic) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM topic_stats WHERE module = ? AND topic = ?').get(module, topic);
  if (!row) return null;
  return {
    ...row,
    companies: JSON.parse(row.companies || '[]'),
    difficultyDist: JSON.parse(row.difficulty_dist || '{}'),
    sampleQuestions: JSON.parse(row.sample_questions || '[]'),
    sampleFollowUps: JSON.parse(row.sample_follow_ups || '[]'),
    knowledgePoints: JSON.parse(row.knowledge_points || '[]'),
  };
}

function getTrendingTopics(limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT module, topic, frequency, company_count, companies, trend, latest_seen
    FROM topic_stats WHERE trend = 'rising'
    ORDER BY frequency DESC LIMIT ?
  `).all(limit).map(r => ({ ...r, companies: JSON.parse(r.companies || '[]') }));
}

function getCrossCompanyTopics(minCompanies = 3, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT module, topic, frequency, company_count, companies, difficulty_dist, trend
    FROM topic_stats WHERE company_count >= ?
    ORDER BY frequency DESC LIMIT ?
  `).all(minCompanies, limit).map(r => ({
    ...r,
    companies: JSON.parse(r.companies || '[]'),
    difficultyDist: JSON.parse(r.difficulty_dist || '{}'),
  }));
}

function getCompanyProfile(companyId, module) {
  const db = getDb();
  if (module) {
    const row = db.prepare('SELECT * FROM company_module_profile WHERE company_id = ? AND module = ?').get(companyId, module);
    if (!row) return null;
    return {
      ...row,
      topTopics: JSON.parse(row.top_topics || '[]'),
      difficultyDist: JSON.parse(row.difficulty_dist || '{}'),
      commonFollowUps: JSON.parse(row.common_follow_ups || '[]'),
    };
  }
  // 返回该公司所有模块画像
  const rows = db.prepare('SELECT * FROM company_module_profile WHERE company_id = ? ORDER BY question_count DESC').all(companyId);
  return rows.map(r => ({
    ...r,
    topTopics: JSON.parse(r.top_topics || '[]'),
    difficultyDist: JSON.parse(r.difficulty_dist || '{}'),
    commonFollowUps: JSON.parse(r.common_follow_ups || '[]'),
  }));
}

// ============ crawled_urls 操作 ============

function isCrawledUrl(url) {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM crawled_urls WHERE url = ?').get(url);
  return !!row;
}

function addCrawledUrl(companyId, url, meta = {}) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO crawled_urls (company_id, url, source, title, published_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(companyId, url, meta.source || null, meta.title || null, meta.publishedAt || null);
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ============ 新增查询函数 ============

/** Task 3.2: 单题完整溯源 */
function getQuestionTrace(questionId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT q.*, i.title as interview_title, i.source_url, i.raw_file,
           i.published_at as interview_published_at, i.level as interview_level,
           i.rounds as interview_rounds, i.result as interview_result,
           i.experience_years, i.company_id as trace_company_id,
           c.name as company_name
    FROM questions q
    JOIN interviews i ON i.id = q.interview_id
    JOIN companies c ON c.id = q.company_id
    WHERE q.id = ?
  `).get(questionId);
  if (!row) return null;

  const kps = db.prepare('SELECT knowledge_point FROM question_knowledge_points WHERE question_id = ?')
    .all(questionId).map(x => x.knowledge_point);
  const fus = db.prepare('SELECT id, follow_up, sort_order, parent_id, depth FROM question_follow_ups WHERE question_id = ? ORDER BY sort_order')
    .all(questionId);
  const relations = db.prepare(`
    SELECT qr.relation_type, qr.confidence, qr.note,
      CASE WHEN qr.question_id_a = ? THEN qr.question_id_b ELSE qr.question_id_a END as related_id,
      rq.content as related_content, rq.topic as related_topic, rq.module as related_module,
      rq.company_id as related_company_id, rq.difficulty as related_difficulty,
      rq.question_style as related_style
    FROM question_relations qr
    JOIN questions rq ON rq.id = CASE WHEN qr.question_id_a = ? THEN qr.question_id_b ELSE qr.question_id_a END
    WHERE qr.question_id_a = ? OR qr.question_id_b = ?
  `).all(questionId, questionId, questionId, questionId);

  return {
    id: row.id,
    company_id: row.company_id,
    module: row.module,
    topic: row.topic,
    type: row.type,
    difficulty: row.difficulty,
    content: row.content,
    raw_content: row.raw_content,
    question_style: row.question_style,
    depth_level: row.depth_level,
    answer_hint: row.answer_hint,
    round: row.round,
    sort_order: row.sort_order,
    knowledgePoints: kps,
    followUps: fus.map(f => ({ id: f.id, content: f.follow_up, sortOrder: f.sort_order, parentId: f.parent_id, depth: f.depth })),
    relations: relations.map(r => ({
      relatedId: r.related_id, type: r.relation_type, confidence: r.confidence, note: r.note,
      content: r.related_content, topic: r.related_topic, module: r.related_module,
      company_id: r.related_company_id, difficulty: r.related_difficulty, question_style: r.related_style,
    })),
    trace: {
      interview_id: row.interview_id,
      title: row.interview_title,
      company_id: row.trace_company_id,
      company_name: row.company_name,
      source_url: row.source_url,
      raw_file: row.raw_file,
      published_at: row.interview_published_at,
      level: row.interview_level,
      rounds: row.interview_rounds,
      result: row.interview_result,
      experience_years: row.experience_years,
    },
  };
}

/** Task 4.1: 知识点频次排名 */
function getFrequencyRank(module) {
  const db = getDb();
  let sql = `
    SELECT kp.knowledge_point, COUNT(*) as count,
           GROUP_CONCAT(DISTINCT q.company_id) as companies
    FROM question_knowledge_points kp
    JOIN questions q ON q.id = kp.question_id
  `;
  const params = [];
  if (module) { sql += ' WHERE q.module = ?'; params.push(module); }
  sql += ' GROUP BY kp.knowledge_point ORDER BY count DESC';
  return db.prepare(sql).all(...params).map(r => ({
    knowledgePoint: r.knowledge_point,
    count: r.count,
    companies: r.companies ? r.companies.split(',') : [],
  }));
}

/** Task 4.2: 追问链模式分析 */
function getFollowUpPatterns(kp) {
  const db = getDb();
  // 找到包含该知识点的题目
  const qIds = db.prepare(`
    SELECT DISTINCT question_id FROM question_knowledge_points WHERE knowledge_point LIKE ?
  `).all(`%${kp}%`).map(r => r.question_id);

  if (!qIds.length) return { knowledgePoint: kp, patterns: [] };

  const pathMap = {};
  const stmtFu = db.prepare('SELECT follow_up, depth FROM question_follow_ups WHERE question_id = ? ORDER BY sort_order');

  for (const qId of qIds) {
    const fus = stmtFu.all(qId);
    if (!fus.length) continue;
    // 用追问内容的前20字符作为路径标识
    const pathKey = fus.map(f => f.follow_up.slice(0, 20)).join(' → ');
    if (!pathMap[pathKey]) pathMap[pathKey] = { path: fus.map(f => f.follow_up), frequency: 0, maxDepth: 0 };
    pathMap[pathKey].frequency++;
    pathMap[pathKey].maxDepth = Math.max(pathMap[pathKey].maxDepth, ...fus.map(f => f.depth || 0));
  }

  const patterns = Object.values(pathMap).sort((a, b) => b.frequency - a.frequency);
  return { knowledgePoint: kp, totalQuestions: qIds.length, patterns };
}

/** Task 4.4: 组合拳模式 */
function getComboPatterns(kp, limit = 10) {
  const db = getDb();
  // 找到包含该知识点的题目
  const anchorRows = db.prepare(`
    SELECT DISTINCT kp.question_id, q.interview_id, q.sort_order
    FROM question_knowledge_points kp
    JOIN questions q ON q.id = kp.question_id
    WHERE kp.knowledge_point LIKE ?
  `).all(`%${kp}%`);

  if (!anchorRows.length) return { anchor: kp, combos: [] };

  const comboMap = {};
  const stmtNext = db.prepare(`
    SELECT q.topic, q.module, q.sort_order, q.id
    FROM questions q WHERE q.interview_id = ? AND q.sort_order > ?
    ORDER BY q.sort_order
  `);
  const stmtKp = db.prepare('SELECT knowledge_point FROM question_knowledge_points WHERE question_id = ?');

  for (const anchor of anchorRows) {
    const nextQs = stmtNext.all(anchor.interview_id, anchor.sort_order);
    for (const nq of nextQs) {
      const nextKps = stmtKp.all(nq.id).map(x => x.knowledge_point);
      const key = nq.topic;
      if (!comboMap[key]) comboMap[key] = { next: nq.topic, module: nq.module, count: 0, totalGap: 0, sampleInterviews: new Set(), knowledgePoints: new Set() };
      comboMap[key].count++;
      comboMap[key].totalGap += nq.sort_order - anchor.sort_order;
      comboMap[key].sampleInterviews.add(anchor.interview_id);
      for (const k of nextKps) comboMap[key].knowledgePoints.add(k);
    }
  }

  const totalAnchors = anchorRows.length;
  const combos = Object.values(comboMap)
    .map(c => ({
      next: c.next,
      module: c.module,
      probability: Math.round((c.count / totalAnchors) * 100) / 100,
      avgGap: Math.round((c.totalGap / c.count) * 10) / 10,
      sampleInterviews: [...c.sampleInterviews].slice(0, 3),
      knowledgePoints: [...c.knowledgePoints].slice(0, 5),
    }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, limit);

  return { anchor: kp, totalAnchorQuestions: totalAnchors, combos };
}

/** Task 4.5: 时间趋势 */
function getTrendTimeline(kp, granularity = 'quarter') {
  const db = getDb();
  let dateExpr;
  if (granularity === 'month') {
    dateExpr = `substr(q.published_at, 1, 7)`;
  } else {
    // quarter: YYYY-QN
    dateExpr = `substr(q.published_at, 1, 4) || '-Q' || ((CAST(substr(q.published_at, 6, 2) AS INTEGER) - 1) / 3 + 1)`;
  }

  const rows = db.prepare(`
    SELECT ${dateExpr} as period, COUNT(*) as count
    FROM questions q
    JOIN question_knowledge_points kp ON kp.question_id = q.id
    WHERE kp.knowledge_point LIKE ? AND q.published_at IS NOT NULL
    GROUP BY period ORDER BY period
  `).all(`%${kp}%`);

  // 趋势判断
  let trend = 'stable';
  if (rows.length >= 2) {
    const half = Math.floor(rows.length / 2);
    const firstHalf = rows.slice(0, half).reduce((s, r) => s + r.count, 0);
    const secondHalf = rows.slice(half).reduce((s, r) => s + r.count, 0);
    if (secondHalf > firstHalf * 1.3) trend = 'rising';
    else if (secondHalf < firstHalf * 0.5) trend = 'declining';
  }

  const peakPeriod = rows.length ? rows.reduce((max, r) => r.count > max.count ? r : max, rows[0]).period : null;

  return { knowledgePoint: kp, granularity, timeline: rows, trend, peakPeriod };
}

/** Task 4.6: 轮次分析 */
function getRoundAnalysis(module, company) {
  const db = getDb();
  let where = 'WHERE q.round IS NOT NULL';
  const params = [];
  if (module) { where += ' AND q.module = ?'; params.push(module); }
  if (company) { where += ' AND q.company_id = ?'; params.push(company); }

  const rows = db.prepare(`
    SELECT q.round, COUNT(*) as count,
           AVG(CASE q.difficulty WHEN 'P5' THEN 1 WHEN 'P6' THEN 2 WHEN 'P7' THEN 3 ELSE 2 END) as avg_diff
    FROM questions q ${where}
    GROUP BY q.round ORDER BY q.round
  `).all(...params);

  const stmtStyles = db.prepare(`
    SELECT q.question_style, COUNT(*) as cnt FROM questions q
    ${where} AND q.round = ? AND q.question_style IS NOT NULL
    GROUP BY q.question_style ORDER BY cnt DESC LIMIT 5
  `);
  const stmtTopics = db.prepare(`
    SELECT q.topic, COUNT(*) as cnt FROM questions q
    ${where} AND q.round = ?
    GROUP BY q.topic ORDER BY cnt DESC LIMIT 5
  `);

  const byRound = {};
  for (const r of rows) {
    const roundParams = [...params, r.round];
    byRound[r.round] = {
      count: r.count,
      avgDifficulty: r.avg_diff <= 1.5 ? 'P5' : r.avg_diff <= 2.5 ? 'P6' : 'P7',
      topStyles: stmtStyles.all(...roundParams).map(s => `${s.question_style}(${s.cnt})`),
      topTopics: stmtTopics.all(...roundParams).map(t => `${t.topic}(${t.cnt})`),
    };
  }
  return { module, company, byRound };
}

/** Task 4.7: 经验年限分析 */
function getExperienceAnalysis(module) {
  const db = getDb();
  let where = 'WHERE i.experience_years IS NOT NULL';
  const params = [];
  if (module) { where += ' AND q.module = ?'; params.push(module); }

  const rows = db.prepare(`
    SELECT i.experience_years, COUNT(*) as count,
           AVG(CASE q.difficulty WHEN 'P5' THEN 1 WHEN 'P6' THEN 2 WHEN 'P7' THEN 3 ELSE 2 END) as avg_diff
    FROM questions q
    JOIN interviews i ON i.id = q.interview_id
    ${where}
    GROUP BY i.experience_years ORDER BY i.experience_years
  `).all(...params);

  const stmtModules = db.prepare(`
    SELECT q.module, COUNT(*) as cnt FROM questions q
    JOIN interviews i ON i.id = q.interview_id
    ${where} AND i.experience_years = ?
    GROUP BY q.module ORDER BY cnt DESC LIMIT 5
  `);

  const byExperience = {};
  for (const r of rows) {
    byExperience[r.experience_years] = {
      count: r.count,
      avgDifficulty: r.avg_diff <= 1.5 ? 'P5' : r.avg_diff <= 2.5 ? 'P6' : 'P7',
      topModules: stmtModules.all(...params, r.experience_years).map(m => `${m.module}(${m.cnt})`),
    };
  }
  return { module, byExperience };
}

/** Task 4.8: 数据概览 */
function getStats() {
  const db = getDb();
  const totalInterviews = db.prepare('SELECT COUNT(*) as cnt FROM interviews').get().cnt;
  const totalQuestions = db.prepare('SELECT COUNT(*) as cnt FROM questions').get().cnt;
  const totalCompanies = db.prepare('SELECT COUNT(*) as cnt FROM companies').get().cnt;
  const byModule = db.prepare('SELECT module, COUNT(*) as cnt FROM questions GROUP BY module ORDER BY cnt DESC').all();
  const byCompany = db.prepare(`
    SELECT q.company_id, c.name, COUNT(*) as cnt FROM questions q
    JOIN companies c ON c.id = q.company_id
    GROUP BY q.company_id ORDER BY cnt DESC
  `).all();
  const byDifficulty = db.prepare('SELECT difficulty, COUNT(*) as cnt FROM questions GROUP BY difficulty').all();
  const byStyle = db.prepare('SELECT question_style, COUNT(*) as cnt FROM questions WHERE question_style IS NOT NULL GROUP BY question_style ORDER BY cnt DESC').all();

  return {
    totalInterviews,
    totalQuestions,
    totalCompanies,
    byModule: byModule.map(r => ({ module: r.module, count: r.cnt })),
    byCompany: byCompany.map(r => ({ company: r.company_id, name: r.name, count: r.cnt })),
    byDifficulty: byDifficulty.reduce((o, r) => { o[r.difficulty || 'unknown'] = r.cnt; return o; }, {}),
    byStyle: byStyle.map(r => ({ style: r.question_style, count: r.cnt })),
  };
}

/** Task 6.1: 覆盖度分析 */
function getCoverageAnalysis(module) {
  const db = getDb();
  const chroniclePath = path.join(DB_DIR, '..', '.work-master', 'learning', 'tech-chronicle.json');
  if (!fs.existsSync(chroniclePath)) return { error: 'tech-chronicle.json not found' };

  const chronicle = JSON.parse(fs.readFileSync(chroniclePath, 'utf-8'));
  const moduleData = chronicle.modules?.[module];
  if (!moduleData) return { error: `Module "${module}" not found in tech-chronicle.json` };

  const stages = [];
  for (const stage of moduleData.stages || []) {
    const stageKps = stage.knowledgePoints || [];
    if (!stageKps.length) {
      stages.push({ stage: stage.id || stage.name, knowledgePoints: [], matchedKPs: [], questionCount: 0, coverage: 'none' });
      continue;
    }

    const placeholders = stageKps.map(() => '?').join(',');
    const matchedRows = db.prepare(`
      SELECT DISTINCT kp.knowledge_point, COUNT(DISTINCT kp.question_id) as cnt
      FROM question_knowledge_points kp
      JOIN questions q ON q.id = kp.question_id
      WHERE q.module = ? AND kp.knowledge_point IN (${placeholders})
      GROUP BY kp.knowledge_point
    `).all(module, ...stageKps);

    const totalCount = matchedRows.reduce((s, r) => s + r.cnt, 0);
    let coverage = 'none';
    if (totalCount >= 10) coverage = 'high';
    else if (totalCount >= 3) coverage = 'medium';
    else if (totalCount >= 1) coverage = 'low';

    stages.push({
      stage: stage.id || stage.name,
      knowledgePoints: stageKps,
      matchedKPs: matchedRows.map(r => ({ kp: r.knowledge_point, count: r.cnt })),
      questionCount: totalCount,
      coverage,
    });
  }

  return { module, stages };
}

/** Task 7.1: 关联分析引擎 */
function buildRelations(options = {}) {
  const db = getDb();

  if (options.rebuild) {
    db.prepare('DELETE FROM question_relations').run();
  }

  // 获取题目及其知识点
  let questionSql = 'SELECT q.id, q.module, q.topic, q.question_style FROM questions q';
  const qParams = [];
  if (options.since && !options.rebuild) {
    questionSql += ' JOIN interviews i ON i.id = q.interview_id WHERE i.created_at >= ?';
    qParams.push(options.since);
  }
  const questions = db.prepare(questionSql).all(...qParams);

  const stmtKp = db.prepare('SELECT knowledge_point FROM question_knowledge_points WHERE question_id = ?');
  const qMap = new Map();
  for (const q of questions) {
    q.kps = new Set(stmtKp.all(q.id).map(r => r.knowledge_point));
    qMap.set(q.id, q);
  }

  // 获取所有已有题目（增量模式需要与已有题目比较）
  let allQuestions;
  if (options.since && !options.rebuild) {
    allQuestions = db.prepare('SELECT q.id, q.module, q.topic, q.question_style FROM questions q').all();
    for (const q of allQuestions) {
      if (!qMap.has(q.id)) {
        q.kps = new Set(stmtKp.all(q.id).map(r => r.knowledge_point));
        qMap.set(q.id, q);
      }
    }
  } else {
    allQuestions = questions;
  }

  // 预定义的前置依赖关系
  const prerequisites = {
    'cas': ['aqs', 'atomic-classes', 'lock-free'],
    'synchronized': ['monitor', 'lock-escalation'],
    'volatile': ['memory-barrier', 'jmm'],
    'thread-pool': ['rejection-policy', 'work-stealing'],
    'b-plus-tree': ['index-optimization', 'clustered-index'],
    'redo-log': ['crash-recovery', 'write-ahead-log'],
    'undo-log': ['mvcc', 'transaction-rollback'],
    'replication': ['master-slave', 'semi-sync'],
    'partition': ['consumer-group', 'rebalance'],
    'isr': ['acks-mechanism', 'replica-sync'],
  };

  const insertRel = db.prepare(`
    INSERT OR IGNORE INTO question_relations (question_id_a, question_id_b, relation_type, confidence, note)
    VALUES (?, ?, ?, ?, ?)
  `);

  // 避免重复插入
  const existingCheck = db.prepare('SELECT 1 FROM question_relations WHERE question_id_a = ? AND question_id_b = ?');

  const txn = db.transaction(() => {
    const newQIds = new Set(questions.map(q => q.id));

    for (const q of questions) {
      const targets = options.rebuild ? allQuestions : allQuestions;
      for (const other of targets) {
        if (other.id <= q.id) continue; // 避免重复对
        if (q.module !== other.module) continue;

        // 增量模式：至少一方是新题目
        if (!options.rebuild && options.since) {
          if (!newQIds.has(q.id) && !newQIds.has(other.id)) continue;
        }

        // 已存在则跳过
        if (existingCheck.get(q.id, other.id) || existingCheck.get(other.id, q.id)) continue;

        const otherData = qMap.get(other.id);
        if (!otherData) continue;

        // 计算知识点交集
        const intersection = [...q.kps].filter(k => otherData.kps.has(k));

        if (intersection.length >= 2) {
          insertRel.run(q.id, other.id, 'same_topic', 0.9, `共同知识点: ${intersection.join(', ')}`);
        } else if (intersection.length === 1) {
          // 检查是否有前置依赖关系
          let isPrereq = false;
          for (const kp of q.kps) {
            const deps = prerequisites[kp];
            if (deps && deps.some(d => otherData.kps.has(d))) {
              insertRel.run(q.id, other.id, 'prerequisite', 0.8, `${kp} → ${deps.filter(d => otherData.kps.has(d)).join(', ')}`);
              isPrereq = true;
              break;
            }
          }
          if (!isPrereq) {
            // 检查 contrast 类型
            if (q.question_style === 'comparison' || otherData.question_style === 'comparison') {
              insertRel.run(q.id, other.id, 'contrast', 0.7, `对比题: ${intersection.join(', ')}`);
            } else {
              insertRel.run(q.id, other.id, 'related', 0.5, `关联知识点: ${intersection.join(', ')}`);
            }
          }
        }
      }
    }
  });
  txn();

  const totalRelations = db.prepare('SELECT COUNT(*) as cnt FROM question_relations').get().cnt;
  return { totalRelations };
}

/** Task 8: 数据质量校验 */
function validateQuestions(options = {}) {
  const db = getDb();
  const issues = [];

  // 检查必填字段
  const questions = db.prepare(`
    SELECT q.id, q.interview_id, q.company_id, q.module, q.topic, q.content,
           q.raw_content, q.question_style, q.depth_level
    FROM questions q
    ${options.company ? 'WHERE q.company_id = ?' : ''}
  `).all(...(options.company ? [options.company] : []));

  for (const q of questions) {
    if (!q.module) issues.push({ level: 'ERROR', questionId: q.id, company: q.company_id, message: 'module 为空' });
    if (!q.question_style) issues.push({ level: 'WARN', questionId: q.id, company: q.company_id, message: 'question_style 为空' });
    if (!q.depth_level) issues.push({ level: 'WARN', questionId: q.id, company: q.company_id, message: 'depth_level 为空' });
    if (!q.raw_content) issues.push({ level: 'INFO', questionId: q.id, company: q.company_id, message: 'raw_content 为空' });
  }

  // 检查知识点
  const noKp = db.prepare(`
    SELECT q.id, q.company_id FROM questions q
    LEFT JOIN question_knowledge_points kp ON kp.question_id = q.id
    WHERE kp.id IS NULL
    ${options.company ? 'AND q.company_id = ?' : ''}
  `).all(...(options.company ? [options.company] : []));
  for (const q of noKp) {
    issues.push({ level: 'ERROR', questionId: q.id, company: q.company_id, message: 'knowledgePoints 为空' });
  }

  // 检查 follow_ups 树完整性
  const brokenFu = db.prepare(`
    SELECT fu.id, fu.question_id, fu.parent_id FROM question_follow_ups fu
    WHERE fu.parent_id IS NOT NULL
    AND fu.parent_id NOT IN (SELECT id FROM question_follow_ups)
  `).all();
  for (const fu of brokenFu) {
    issues.push({ level: 'ERROR', questionId: fu.question_id, message: `follow_up #${fu.id} 的 parent_id=${fu.parent_id} 指向不存在的记录` });
  }

  // 检查单篇面经 0 题
  const emptyInterviews = db.prepare(`
    SELECT i.id, i.company_id FROM interviews i
    LEFT JOIN questions q ON q.interview_id = i.id
    WHERE q.id IS NULL
  `).all();
  for (const iv of emptyInterviews) {
    issues.push({ level: 'ERROR', interviewId: iv.id, company: iv.company_id, message: '面经无题目' });
  }

  // --fix 模式
  if (options.fix) {
    const fixStyle = db.prepare("UPDATE questions SET question_style = 'concept' WHERE question_style IS NULL");
    const fixDepth = db.prepare("UPDATE questions SET depth_level = 'surface' WHERE depth_level IS NULL");
    const fixedStyle = fixStyle.run().changes;
    const fixedDepth = fixDepth.run().changes;
    issues.push({ level: 'INFO', message: `自动修正: question_style ${fixedStyle} 条, depth_level ${fixedDepth} 条` });
  }

  return issues;
}

// ============ 贡献者相关 ============

/**
 * 通过 content_hash 查找已存在的面经
 */
function findInterviewByHash(contentHash) {
  const db = getDb();
  return db.prepare('SELECT id, company_id, trust_level FROM interviews WHERE content_hash = ?').get(contentHash) || null;
}

/**
 * 记录贡献者（同一面经多人贡献）
 */
function addContributor(interviewId, contributorId) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO interview_contributors (interview_id, contributor_id) VALUES (?, ?)').run(interviewId, contributorId);
}

/**
 * 标记面经已推送
 */
function markPushed(interviewId) {
  const db = getDb();
  db.prepare("UPDATE interviews SET pushed_at = datetime('now') WHERE id = ?").run(interviewId);
}

/**
 * 获取未推送的面经列表（按公司）
 */
function getUnpushedInterviews(companyId, limit = 10) {
  const db = getDb();
  const where = companyId ? 'WHERE i.company_id = ? AND i.pushed_at IS NULL' : 'WHERE i.pushed_at IS NULL';
  const params = companyId ? [companyId, limit] : [limit];
  return db.prepare(`
    SELECT i.id, i.company_id, i.title, i.source_url, i.published_at,
           i.position, i.recruit_type, i.content_hash,
           COUNT(q.id) as question_count
    FROM interviews i
    LEFT JOIN questions q ON q.interview_id = i.id
    ${where}
    GROUP BY i.id
    ORDER BY i.created_at DESC
    LIMIT ?
  `).all(...params);
}

/**
 * 获取维度列表（用于前端筛选栏）
 */
function getDimensions() {
  const db = getDb();
  const positions = db.prepare("SELECT DISTINCT position FROM interviews WHERE position IS NOT NULL").all().map(r => r.position);
  const recruitTypes = db.prepare("SELECT DISTINCT recruit_type FROM interviews WHERE recruit_type IS NOT NULL").all().map(r => r.recruit_type);
  return { positions, recruitTypes };
}

// ============ exports ============

// ============ extraction_log 方法 ============

function logExtraction({ companyId, filename, status, questionsExtracted = 0, skipReason = null, multiCompany = false, splitTo = null, questionsByCompany = null, interviewId = null }) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO extraction_log (company_id, filename, status, questions_extracted, skip_reason, multi_company, split_to, questions_by_company, interview_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    companyId, filename, status, questionsExtracted,
    skipReason || null,
    multiCompany ? 1 : 0,
    splitTo ? JSON.stringify(splitTo) : null,
    questionsByCompany ? JSON.stringify(questionsByCompany) : null,
    interviewId || null
  );
}

function getExtractionStatus(companyId, filename) {
  const db = getDb();
  return db.prepare('SELECT * FROM extraction_log WHERE company_id = ? AND filename = ?').get(companyId, filename) || null;
}

function getExtractionStats() {
  const db = getDb();
  const total = db.prepare(`
    SELECT
      COUNT(*) as totalFiles,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as totalDone,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as totalSkipped,
      SUM(questions_extracted) as totalQuestions
    FROM extraction_log
  `).get();

  const byCompany = db.prepare(`
    SELECT
      company_id,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
      SUM(questions_extracted) as questionsExtracted
    FROM extraction_log
    GROUP BY company_id
    ORDER BY company_id
  `).all();

  return { ...total, byCompany };
}

function isFileProcessed(companyId, filename) {
  const db = getDb();
  const row = db.prepare('SELECT status FROM extraction_log WHERE company_id = ? AND filename = ?').get(companyId, filename);
  return row ? row.status : null;
}

module.exports = {
  DB_DIR,
  getDb,
  isCrawledUrl,
  addCrawledUrl,
  closeDb,
  upsertCompany,
  getCompany,
  updateCompanyStats,
  insertInterview,
  getProcessedUrls,
  getInterviewCount,
  generateInterviewId,
  queryQuestions,
  ftsSearch,
  refreshTopicStats,
  refreshCompanyProfiles,
  getHotTopics,
  getTopicDetail,
  getTrendingTopics,
  getCrossCompanyTopics,
  getCompanyProfile,
  syncFts,
  rebuildFts,
  // extraction_log
  logExtraction,
  getExtractionStatus,
  getExtractionStats,
  isFileProcessed,
  // 新增
  getQuestionTrace,
  getFrequencyRank,
  getFollowUpPatterns,
  getComboPatterns,
  getTrendTimeline,
  getRoundAnalysis,
  getExperienceAnalysis,
  getStats,
  getCoverageAnalysis,
  buildRelations,
  validateQuestions,
  // 贡献者/推送
  findInterviewByHash,
  addContributor,
  markPushed,
  getUnpushedInterviews,
  getDimensions,
};
