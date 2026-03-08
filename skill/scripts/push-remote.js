#!/usr/bin/env node
/**
 * 面经情报 — 推送到远程站
 *
 * 用法：
 *   node push-remote.js                    推送所有未推送面经
 *   node push-remote.js --company alibaba  只推送指定公司
 *   node push-remote.js --dry-run          预览不实际推送
 *   node push-remote.js --status           查看推送进度
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.resolve(__dirname, '../../data');
const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');

// ─── 加载 profile ───

function loadProfile() {
  try { return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8')); }
  catch { return null; }
}

// ─── SHA256 content_hash ───

function hashInterview(interview) {
  // 用 sourceUrl + title + 前3道题 topic 生成稳定 hash
  const key = [
    interview.sourceUrl || '',
    interview.title || '',
    ...(interview.questions || []).slice(0, 3).map(q => q.topic || ''),
  ].join('|');
  return crypto.createHash('sha256').update(key).digest('hex');
}

// ─── 批量推送 ───

const BATCH_SIZE = 10;
const MAX_PER_DAY = 100;
const MAX_PER_REQUEST = 20;

async function pushBatch(siteUrl, token, interviews) {
  const url = `${siteUrl}/api/contribute/upload`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ interviews }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const statusOnly = args.includes('--status');
  const companyIdx = args.indexOf('--company');
  const targetCompany = companyIdx >= 0 ? args[companyIdx + 1] : null;

  const profile = loadProfile();
  if (!profile) {
    console.error('❌ 未找到 profile.json，请先运行 node init-profile.js');
    process.exit(1);
  }

  const { enabled, siteUrl, token } = profile.remote || {};
  if (!enabled || !token) {
    console.error('❌ 远程推送未启用，请运行 node init-profile.js --set-token <token>');
    process.exit(1);
  }

  // 延迟加载 db（避免在 --status 前就初始化）
  const db = require('./db');

  if (statusOnly) {
    const unpushed = db.getUnpushedInterviews(targetCompany, 1000);
    const dims = db.getDimensions();
    console.log(`\n📊 推送状态`);
    console.log(`   未推送面经：${unpushed.length} 篇`);
    console.log(`   岗位维度：${dims.positions.join(', ') || '无'}`);
    console.log(`   招聘类型：${dims.recruitTypes.join(', ') || '无'}`);
    if (targetCompany) console.log(`   过滤公司：${targetCompany}`);
    return;
  }

  // 获取未推送列表
  const unpushed = db.getUnpushedInterviews(targetCompany, MAX_PER_DAY);
  if (unpushed.length === 0) {
    console.log('✅ 没有待推送的面经');
    return;
  }

  console.log(`\n🚀 准备推送 ${unpushed.length} 篇面经到 ${siteUrl}`);
  if (dryRun) console.log('   [dry-run 模式，不实际推送]');

  let successCount = 0;
  let failCount = 0;

  // 按批次推送
  for (let i = 0; i < unpushed.length; i += BATCH_SIZE) {
    const batch = unpushed.slice(i, Math.min(i + BATCH_SIZE, unpushed.length));
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(unpushed.length / BATCH_SIZE);

    console.log(`\n  批次 ${batchNum}/${totalBatches}（${batch.length} 篇）...`);

    // 构建推送数据（从 DB 读取完整面经）
    const interviews = [];
    for (const row of batch) {
      try {
        const fullInterview = buildPushPayload(db, row);
        interviews.push(fullInterview);
      } catch (e) {
        console.warn(`    ⚠️  ${row.id} 构建失败: ${e.message}`);
      }
    }

    if (dryRun) {
      console.log(`    [dry-run] 将推送 ${interviews.length} 篇`);
      interviews.forEach(iv => console.log(`      - ${iv.id}: ${iv.title?.slice(0, 40)}`));
      successCount += interviews.length;
      continue;
    }

    try {
      const result = await pushBatch(siteUrl, token, interviews);
      const accepted = result.accepted || interviews.length;
      const skipped = result.skipped || 0;
      console.log(`    ✅ 成功 ${accepted} 篇，跳过(重复) ${skipped} 篇`);

      // 标记已推送（每条单独标记，保证断点续传）
      for (const iv of interviews) {
        try { db.markPushed(iv.id); } catch (_) {}
      }
      successCount += accepted;
    } catch (e) {
      console.error(`    ❌ 批次失败: ${e.message}`);
      failCount += interviews.length;
      // 失败不中断，继续下一批
    }

    // 批次间短暂等待，避免触发限流
    if (i + BATCH_SIZE < unpushed.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n📊 推送完成：成功 ${successCount} 篇，失败 ${failCount} 篇`);
}

/**
 * 从 DB 构建推送 payload
 */
function buildPushPayload(db, row) {
  const dbInstance = db.getDb();

  // 获取题目
  const questions = dbInstance.prepare(`
    SELECT q.*, GROUP_CONCAT(kp.knowledge_point, '|') as kps
    FROM questions q
    LEFT JOIN question_knowledge_points kp ON kp.question_id = q.id
    WHERE q.interview_id = ?
    GROUP BY q.id
    ORDER BY q.sort_order
  `).all(row.id);

  const questionsWithFu = questions.map(q => {
    const followUps = dbInstance.prepare(
      'SELECT follow_up FROM question_follow_ups WHERE question_id = ? ORDER BY sort_order'
    ).all(q.id).map(f => f.follow_up);
    return {
      module: q.module,
      topic: q.topic,
      type: q.type,
      difficulty: q.difficulty,
      content: q.content,
      answerHint: q.answer_hint,
      round: q.round,
      knowledgePoints: q.kps ? q.kps.split('|').filter(Boolean) : [],
      followUps,
    };
  });

  // 生成 content_hash（如果 DB 里没有）
  const contentHash = row.content_hash || hashInterview({
    sourceUrl: row.source_url,
    title: row.title,
    questions: questionsWithFu,
  });

  return {
    id: row.id,
    companyId: row.company_id,
    title: row.title,
    sourceUrl: row.source_url,
    publishedAt: row.published_at,
    position: row.position,
    recruitType: row.recruit_type,
    contentHash,
    questions: questionsWithFu,
  };
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
