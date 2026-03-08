#!/usr/bin/env node
/**
 * 面经情报 MCP Server v2 — 自然文本输出，极致精简 token 消耗
 *
 * 环境变量：
 *   INTERVIEW_INTEL_API_URL  — 后端地址（默认 http://106.54.196.46:4173）
 *   INTERVIEW_INTEL_TOKEN    — API Token
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = (process.env.INTERVIEW_INTEL_API_URL || 'http://106.54.196.46:4173').replace(/\/$/, '');
const API_TOKEN = process.env.INTERVIEW_INTEL_TOKEN || '';

async function api(path, params = {}) {
  const url = new URL(`${API_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const headers = { 'User-Agent': 'interview-intel-mcp/2.0' };
  if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function apiPost(path, body) {
  const url = `${API_URL}${path}`;
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'interview-intel-mcp/2.0' };
  if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

const txt = (s) => ({ content: [{ type: 'text', text: s }] });
const server = new McpServer({ name: 'interview-intel', version: '2.0.0' });

// ===== stats =====
server.tool('stats', '面经数据库概览', {
  position: z.string().optional().describe('岗位方向过滤：java-backend/go-backend/frontend/...'),
  recruitType: z.string().optional().describe('招聘类型过滤：social/campus/intern'),
}, async ({ position, recruitType }) => {
  const d = await api('/api/mcp/overview', { position, recruitType });
  const mods = (d.modules || []).join('、');
  const cos = d.companies?.slice(0, 8).map(c => `${c.name}(${c.questions})`).join('、') || '';
  return txt(`面经库：${d.totalQuestions}题/${d.totalInterviews}篇/${d.companiesCollected}家公司\n模块：${mods}\n公司：${cos}`);
});

// ===== hot_topics =====
server.tool('hot_topics', '某模块高频考点 Top10', {
  module: z.string().describe('模块名（必填）：mysql/redis/concurrent/jvm/java-basic/kafka/mq'),
  position: z.string().optional().describe('岗位方向过滤'),
  recruitType: z.string().optional().describe('招聘类型过滤：social/campus/intern'),
}, async ({ module, position, recruitType }) => {
  const d = await api('/api/mcp/hot-topics', { position, recruitType });
  const info = d.byModule?.[module];
  if (!info) return txt(`模块 ${module} 无数据，可选：${Object.keys(d.byModule || {}).join('/')}`);
  const lines = (info.topQuestions || []).slice(0, 10).map((q, i) =>
    `${i + 1}. ${q.topic} ${q.frequency}次${q.trend ? '/' + q.trend : ''}`
  );
  return txt(`[${module} 高频考点] 共${info.totalMentions}次提及\n${lines.join('\n')}`);
});

// ===== frequency_rank =====
server.tool('frequency_rank', '知识点面经频次排名 Top30', {
  module: z.string().describe('模块名（必填）：mysql/redis/concurrent/jvm/java-basic/kafka/mq'),
}, async ({ module }) => {
  const data = await api('/api/mcp/frequency-rank', { module, limit: 30 });
  const items = Array.isArray(data) ? data : [];
  const lines = items.slice(0, 30).map((r, i) => {
    const kp = r.kp || r.knowledgePoint || r.knowledge_point;
    const freq = r.count || r.frequency;
    const cos = r.company_count || 0;
    return `${i + 1}. ${kp} ${freq}次/${cos}家`;
  });
  return txt(`[${module} 知识点频次]\n${lines.join('\n')}`);
});

// ===== follow_up_patterns =====
server.tool('follow_up_patterns', '知识点的面试追问路径', {
  kp: z.string().describe('知识点，如"间隙锁"、"线程池"'),
}, async ({ kp }) => {
  const d = await api('/api/mcp/follow-up-patterns', { kp, detail: 'normal' });
  const lines = (d.patterns || []).slice(0, 8).map((p, i) => {
    const path = (p.path || []).map(s => s?.slice(0, 40)).join(' → ');
    return `${i + 1}. [${p.frequency}次] ${path}`;
  });
  return txt(`[${kp} 追问链] 共${d.totalQuestions || 0}题\n${lines.join('\n')}`);
});

// ===== combo_patterns =====
server.tool('combo_patterns', '问完某知识点后面试官接着问什么', {
  kp: z.string().describe('知识点'),
  limit: z.number().optional().describe('返回数量，默认8'),
}, async ({ kp, limit }) => {
  const d = await api('/api/mcp/combo-patterns', { kp, limit: limit || 8 });
  const lines = (d.combos || []).slice(0, 10).map((c, i) =>
    `${i + 1}. ${c.next}(${c.module}) 概率${Math.round(c.probability * 100)}% 间隔${c.avgGap}题`
  );
  return txt(`[${kp} 组合拳] 基于${d.totalAnchorQuestions || 0}道锚点题\n${lines.join('\n')}`);
});

// ===== trend =====
server.tool('trend', '知识点考察趋势（rising/stable/declining）', {
  kp: z.string().describe('知识点'),
}, async ({ kp }) => {
  const d = await api('/api/mcp/trend', { kp, granularity: 'quarter' });
  const recent = (d.timeline || []).slice(-4).map(t => `${t.period}:${t.count}次`).join('、');
  return txt(`[${kp} 趋势] ${d.trend || 'stable'}${d.peakPeriod ? '，峰值' + d.peakPeriod : ''}\n近期：${recent || '无数据'}`);
});

// ===== round_analysis =====
server.tool('round_analysis', '一面/二面/三面分别考什么', {
  module: z.string().optional().describe('模块名'),
  company: z.string().optional().describe('公司 ID'),
}, async ({ module, company }) => {
  const d = await api('/api/mcp/round-analysis', { module, company });
  const byRound = d.byRound || d || {};
  const lines = [];
  for (const [round, info] of Object.entries(byRound)) {
    if (!info || typeof info !== 'object') continue;
    const topics = (info.topTopics || []).slice(0, 5).join('、');
    const styles = (info.topStyles || info.styles || []).slice(0, 3).join('、');
    lines.push(`${round}面(${info.count}题/${info.avgDifficulty || ''}): ${topics}${styles ? ' | 题型:' + styles : ''}`);
  }
  const label = [module, company].filter(Boolean).join('/') || '全局';
  return txt(`[${label} 轮次分析]\n${lines.join('\n')}`);
});

// ===== cross_company =====
server.tool('cross_company', '多公司共同考察的必考知识点', {
  min_companies: z.number().optional().describe('最少覆盖公司数，默认3'),
  limit: z.number().optional().describe('返回数量，默认15'),
}, async ({ min_companies, limit }) => {
  const data = await api('/api/mcp/cross-company', { minCompanies: min_companies || 3, limit: limit || 15 });
  const items = Array.isArray(data) ? data : [];
  const lines = items.slice(0, 20).map((r, i) =>
    `${i + 1}. ${r.topic}(${r.module}) ${r.frequency}次/${r.company_count}家${r.trend ? ' ' + r.trend : ''}`
  );
  return txt(`[跨公司必考点]\n${lines.join('\n')}`);
});

// ===== company_profile =====
server.tool('company_profile', '公司面试风格画像', {
  company: z.string().describe('公司 ID：alibaba/bytedance/meituan/pdd/ctrip/baidu/tencent'),
}, async ({ company }) => {
  const d = await api(`/api/mcp/company-profile/${company}`);
  const profiles = d.profiles || [];
  const lines = profiles.slice(0, 8).map(p => {
    const topics = (p.topTopics || []).slice(0, 5).join('、');
    const diff = p.difficultyDist ? Object.entries(p.difficultyDist).map(([k, v]) => `P${k}:${v}`).join('/') : '';
    return `· ${p.module}(${p.question_count}题) 热点:${topics}${diff ? ' 难度:' + diff : ''}`;
  });
  const fus = profiles.slice(0, 3).flatMap(p => (p.commonFollowUps || []).slice(0, 2));
  let text = `[${company} 面试画像]\n${lines.join('\n')}`;
  if (fus.length) text += `\n常见追问：${fus.slice(0, 5).join('；')}`;
  return txt(text);
});

// ===== experience_analysis =====
server.tool('experience_analysis', '不同工作年限考察内容差异', {
  module: z.string().optional().describe('模块名'),
}, async ({ module }) => {
  const d = await api('/api/mcp/experience-analysis', { module });
  const byExp = d.byExperience || d || {};
  const lines = [];
  for (const [exp, info] of Object.entries(byExp)) {
    if (!info || typeof info !== 'object') continue;
    const mods = (info.topModules || []).slice(0, 5).join('、');
    lines.push(`${exp}年: ${info.count}题 难度${info.avgDifficulty || ''} 重点:${mods}`);
  }
  return txt(`[经验年限分析${module ? ' ' + module : ''}]\n${lines.join('\n')}`);
});

// ===== search_questions =====
server.tool('search_questions', '搜索面经题目（多维筛选）', {
  module: z.string().optional().describe('模块：mysql/redis/concurrent/jvm/java-basic/kafka/mq'),
  company: z.string().optional().describe('公司 ID'),
  difficulty: z.string().optional().describe('难度：P5/P6/P7'),
  kp: z.string().optional().describe('知识点关键词，逗号分隔'),
  keyword: z.string().optional().describe('关键词搜索'),
  style: z.string().optional().describe('题型：八股/简答/场景设计/代码题/系统设计'),
  position: z.string().optional().describe('岗位方向：java-backend/go-backend/frontend/...'),
  recruitType: z.string().optional().describe('招聘类型：social/campus/intern'),
  limit: z.number().optional().describe('返回数量，默认5，最大10'),
  offset: z.number().optional().describe('分页偏移，默认0'),
}, async ({ module, company, difficulty, kp, keyword, style, position, recruitType, limit, offset }) => {
  const lim = Math.min(limit || 5, 10);
  const off = offset || 0;
  const d = await api('/api/mcp/questions', {
    module, company, difficulty, kp, keyword, style, position, recruitType,
    limit: lim, offset: off, detail: 'normal',
  });
  const qs = d.questions || [];
  const lines = qs.map((q, i) => {
    const meta = [q.company || q.company_name, q.module, q.difficulty, q.round ? q.round + '面' : ''].filter(Boolean).join('/');
    const kps = (q.knowledgePoints || []).slice(0, 4).join(',');
    const summary = q.summary || q.content?.slice(0, 80) || '';
    return `${off + i + 1}. [${meta}] ${q.topic}${q.id ? '(#' + q.id + ')' : ''}\n   ${summary}${kps ? '\n   KP:' + kps : ''}`;
  });
  const hasMore = off + lim < d.total;
  return txt(`[搜索结果] ${d.total}题${hasMore ? '，还有更多(offset=' + (off + lim) + ')' : ''}\n${lines.join('\n')}`);
});

// ===== question_detail =====
server.tool('question_detail', '单题完整详情', {
  id: z.number().describe('题目 ID'),
}, async ({ id }) => {
  const q = await api(`/api/mcp/questions/${id}`);
  const meta = [q.company_id, q.module, q.difficulty, q.round ? q.round + '面' : ''].filter(Boolean).join('/');
  const kps = (q.knowledgePoints || []).join('、');
  const fus = (q.followUps || []).slice(0, 8).map((f, i) => `  ${i + 1}. ${(f.content || f)?.slice(0, 60)}`).join('\n');
  const related = (q.relatedQuestions || []).slice(0, 5).map(r => `#${r.id} ${r.topic}`).join('、');
  let text = `[#${q.id}] ${q.topic} (${meta})\nKP: ${kps}\n${q.content || ''}`;
  if (fus) text += `\n追问链:\n${fus}`;
  if (related) text += `\n关联题: ${related}`;
  return txt(text);
});

// ===== study_guide =====
server.tool('study_guide', '学习优先级建议（必传 module）', {
  company: z.string().optional().describe('目标公司 ID'),
  module: z.string().describe('目标模块（必填）：mysql/redis/concurrent/jvm/java-basic/kafka/mq'),
}, async ({ company, module }) => {
  const [cross, freq] = await Promise.all([
    api('/api/mcp/cross-company', { minCompanies: 5, limit: 10 }),
    api('/api/mcp/frequency-rank', { module, limit: 15 }),
  ]);
  const mustLines = (Array.isArray(cross) ? cross : []).slice(0, 10).map((t, i) =>
    `${i + 1}. ${t.topic}(${t.module}) ${t.frequency}次/${t.company_count}家${t.trend ? ' ' + t.trend : ''}`
  );
  const freqItems = Array.isArray(freq) ? freq : [];
  const modLines = freqItems.slice(0, 15).map((r, i) =>
    `${i + 1}. ${r.kp || r.knowledgePoint} ${r.count || r.frequency}次`
  );
  let text = `[${module} 学习指南]\n\n必考（跨公司高频）:\n${mustLines.join('\n')}\n\n${module}模块 Top15:\n${modLines.join('\n')}`;
  if (company) {
    try {
      const d = await api(`/api/mcp/company-profile/${company}`);
      const p = (d.profiles || []).find(x => x.module === module);
      if (p) text += `\n\n${company}重点: ${p.question_count}题，热点:${(p.topTopics || []).slice(0, 5).join('、')}`;
    } catch {}
  }
  return txt(text);
});

// ===== push_data =====
server.tool('push_data', '将本地面经数据推送到公共面经情报站', {
  interviews: z.array(z.object({
    id: z.string().optional(),
    companyId: z.string().describe('公司 ID，如 alibaba/bytedance'),
    title: z.string().describe('面经标题'),
    sourceUrl: z.string().optional(),
    publishedAt: z.string().optional(),
    position: z.string().optional().describe('岗位方向：java-backend/go-backend/frontend/...'),
    recruitType: z.string().optional().describe('招聘类型：social/campus/intern'),
    contentHash: z.string().optional().describe('SHA256 去重 hash'),
    questions: z.array(z.object({
      module: z.string(),
      topic: z.string(),
      type: z.string().optional(),
      difficulty: z.string().optional(),
      content: z.string().optional(),
      answerHint: z.string().optional(),
      round: z.number().optional(),
      knowledgePoints: z.array(z.string()).optional(),
      followUps: z.array(z.string()).optional(),
    })).describe('题目列表'),
  })).describe('面经数组，单次最多 20 篇'),
}, async ({ interviews }) => {
  if (!API_TOKEN) return txt('❌ 未配置 INTERVIEW_INTEL_TOKEN，无法推送');
  const result = await apiPost('/api/contribute/upload', { interviews });
  const { accepted = 0, skipped = 0, errors = [] } = result;
  let text = `推送完成：接受 ${accepted} 篇，跳过(重复) ${skipped} 篇`;
  if (errors.length) text += `\n失败 ${errors.length} 篇：${errors.slice(0, 3).map(e => e.reason).join('；')}`;
  return txt(text);
});

// ===== dimensions =====
server.tool('dimensions', '获取数据库中的岗位/招聘类型维度列表', {}, async () => {
  const d = await api('/api/mcp/dimensions');
  return txt(`岗位方向：${(d.positions || []).join('、') || '无'}\n招聘类型：${(d.recruitTypes || []).join('、') || '无'}`);
});

// ===== 启动 =====
const transport = new StdioServerTransport();
await server.connect(transport);
