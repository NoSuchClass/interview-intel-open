import express from 'express';
import cors from 'cors';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const app = express();
const PORT = 3002;

// ===== 配置 =====
const PROJECT_DIR = process.env.PROJECT_DIR || path.resolve(__dirname, '..');
const INTEL_DB_PATH = path.resolve(PROJECT_DIR, 'skill/scripts/db.js');
const API_TOKEN = process.env.API_TOKEN || 'tiaozi-intel-2026';
const ACCESS_KEY = process.env.ACCESS_KEY || 'bit';
const JWT_SECRET = process.env.JWT_SECRET || 'tiaozi-jwt-secret-2026';

app.use(cors());
app.use(express.json());

// ===== 时区工具（+8 北京时间）=====
function getTodayCST() {
  const now = new Date();
  // UTC+8 偏移 8 小时
  const cst = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return cst.toISOString().slice(0, 10);
}

console.log(`[IntelSite] 项目目录: ${PROJECT_DIR}`);
console.log(`[IntelSite] 数据库模块: ${INTEL_DB_PATH}`);

// ===== IP 频率限制 + 封禁（替代全局 token 鉴权）=====
// 规则：5min 内同一 IP 超过 100 次请求 → 写 DB 封禁，返回 429
const ipRateMap = new Map(); // ip -> { count, windowStart }

function ensureRateLimitDb() {
  const db = getIntelDb().getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ip_bans (
      ip TEXT PRIMARY KEY,
      banned_at TEXT NOT NULL,
      reason TEXT
    );
  `);
}

let rateLimitDbReady = false;
function getIpBanDb() {
  if (!rateLimitDbReady) { ensureRateLimitDb(); rateLimitDbReady = true; }
  return getIntelDb().getDb();
}

function isIpBanned(ip) {
  try {
    const row = getIpBanDb().prepare('SELECT ip FROM ip_bans WHERE ip = ?').get(ip);
    return !!row;
  } catch { return false; }
}

function banIp(ip, reason) {
  try {
    getIpBanDb().prepare('INSERT OR IGNORE INTO ip_bans (ip, banned_at, reason) VALUES (?, ?, ?)').run(ip, new Date().toISOString(), reason);
    console.log(`[RateLimit] IP 封禁: ${ip} — ${reason}`);
  } catch {}
}

function checkRateLimit(ip) {
  const now = Date.now();
  const WINDOW = 5 * 60 * 1000; // 5min
  const LIMIT = 100;

  let entry = ipRateMap.get(ip);
  if (!entry || now - entry.windowStart > WINDOW) {
    entry = { count: 1, windowStart: now };
  } else {
    entry.count++;
  }
  ipRateMap.set(ip, entry);

  if (entry.count > LIMIT) {
    banIp(ip, `超过频率限制：5min ${entry.count}次`);
    return false;
  }
  return true;
}

// 全局 IP 封禁 + 频率检查中间件
app.use((req, res, next) => {
  let ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);

  // 跳过静态资源
  if (!req.path.startsWith('/api') && !req.path.startsWith('/mcp')) return next();

  if (isIpBanned(ip)) return res.status(429).json({ error: 'Too many requests, IP banned' });
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Rate limit exceeded' });

  // accessLevel：有 access key 时为 full，否则 public
  const accessKey = req.headers['x-access-key'] || req.query._ak;
  req.accessLevel = (accessKey === ACCESS_KEY) ? 'full' : 'public';

  next();
});

// ===== DB helper =====
function getIntelDb() {
  return require(INTEL_DB_PATH);
}

// SQLite datetime('now') 存的是 UTC，格式 "2026-03-01 06:03:47"
// 统一转成带 Z 的 ISO 格式，让前端能正确识别为 UTC
function toUTC(val) {
  if (!val || typeof val !== 'string') return val;
  // 已经是 ISO 格式（含 T 或 Z）则直接返回
  if (val.includes('T') || val.endsWith('Z')) return val;
  return val.replace(' ', 'T') + 'Z';
}

// 对一个对象的所有时间字段统一加 Z
const TIME_FIELDS = ['created_at', 'called_at', 'last_called', 'last_used_at', 'last_active',
  'first_visit_at', 'visited_at', 'banned_at', 'updated_at'];
function normalizeTimestamps(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const result = { ...obj };
  for (const key of TIME_FIELDS) {
    if (key in result) result[key] = toUTC(result[key]);
  }
  return result;
}

// ===== 访问统计（DB 持久化） =====
const onlineMap = new Map(); // ip -> lastActive timestamp（在线判断仍用内存）

function getVisitorDb() {
  const db = getIntelDb().getDb();
  // 建表（幂等）
  db.exec(`
    CREATE TABLE IF NOT EXISTS visitor_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      date TEXT NOT NULL,
      first_visit_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_visitor_ip_date ON visitor_logs(ip, date);
  `);
  // 迁移：详细访问日志表（每次请求都记录）
  db.exec(`
    CREATE TABLE IF NOT EXISTS visitor_detail_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      path TEXT,
      user_agent TEXT,
      referer TEXT,
      source TEXT NOT NULL DEFAULT 'web',
      visited_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vdl_ip ON visitor_detail_logs(ip);
    CREATE INDEX IF NOT EXISTS idx_vdl_visited ON visitor_detail_logs(visited_at);
  `);
  // 迁移：给已有表加 source 列（幂等）
  try { db.exec(`ALTER TABLE visitor_detail_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'web'`); } catch {}
  // 迁移：给已有表加 user_id 列（幂等）
  try { db.exec(`ALTER TABLE visitor_detail_logs ADD COLUMN user_id INTEGER`); } catch {}
  return db;
}

let visitorDbReady = false;
function ensureVisitorDb() {
  if (!visitorDbReady) { getVisitorDb(); visitorDbReady = true; }
}

// ===== 用户 & MCP Token 表初始化 =====
let authDbReady = false;
function ensureAuthDb() {
  if (authDbReady) return;
  const db = getIntelDb().getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'beta',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mcp_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT 'interview-intel',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS mcp_call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      token TEXT,
      tool_name TEXT NOT NULL,
      params TEXT,
      called_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
  // 迁移：给已有 users 表加 role 列（幂等）
  try { db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'beta'`); } catch {}
  // 迁移：给已有 mcp_tokens 表加 scopes 列（幂等）
  try { db.exec(`ALTER TABLE mcp_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT 'interview-intel'`); } catch {}
  // 预注册 root 管理员（幂等）
  const rootExists = db.prepare('SELECT id FROM users WHERE username = ?').get('root');
  if (!rootExists) {
    const hash = bcrypt.hashSync('liuyuehe123', 10);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('root', hash, 'admin');
    console.log('[Auth] root 管理员已创建');
  }
  authDbReady = true;
}

// ===== JWT 认证中间件 =====
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    ensureAuthDb();
    const db = getIntelDb().getDb();
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// ===== MCP Token 鉴权（用于 MCP API 调用）=====
// 返回 { userId, token, scopes } 或 null
function verifyMcpToken(token) {
  if (!token) return null;
  if (token === API_TOKEN) return { userId: null, token, scopes: ['*'] };
  try {
    ensureAuthDb();
    const db = getIntelDb().getDb();
    const row = db.prepare('SELECT id, user_id, scopes FROM mcp_tokens WHERE token = ? AND is_active = 1').get(token);
    if (row) {
      db.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
      const scopes = row.scopes ? row.scopes.split(',').map(s => s.trim()) : ['interview-intel'];
      return { userId: row.user_id, token, scopes };
    }
  } catch {}
  return null;
}

function logMcpCall(userId, token, toolName, params) {
  try {
    ensureAuthDb();
    const db = getIntelDb().getDb();
    db.prepare('INSERT INTO mcp_call_logs (user_id, token, tool_name, params) VALUES (?, ?, ?, ?)')
      .run(userId || null, token || null, toolName, params ? JSON.stringify(params) : null);
  } catch {}
}

function trackVisitor(req) {
  // 获取真实 IP（支持反向代理）
  let ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress 
    || req.ip 
    || 'unknown';
  
  // 清理 IPv6 映射的 IPv4 地址（::ffff:127.0.0.1 -> 127.0.0.1）
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  
  const now = Date.now();
  // 在线状态（内存）
  onlineMap.set(ip, now);
  const cutoff = now - 5 * 60 * 1000;
  for (const [k, v] of onlineMap) { if (v < cutoff) onlineMap.delete(k); }
  
  // 持久化到 DB（每个 IP 每天只写一条）
  try {
    ensureVisitorDb();
    const today = getTodayCST();
    const db = getIntelDb().getDb();
    db.prepare('INSERT OR IGNORE INTO visitor_logs (ip, date, first_visit_at) VALUES (?, ?, ?)').run(ip, today, new Date().toISOString());
    // 详细访问日志（API 请求才记录，静态资源和高频轮询接口跳过）
    if ((req.path.startsWith('/api') || req.path.startsWith('/mcp')) && req.path !== '/api/stats/visitors' && req.path !== '/api/health') {
      const source = req.path.startsWith('/api/mcp/') || req.path.startsWith('/mcp') ? 'mcp' : 'web';
      // 尝试从 JWT 或 MCP token 提取 user_id（非阻塞，仅用于日志）
      let userId = null;
      try {
        const auth = req.headers['authorization'];
        if (auth && auth.startsWith('Bearer ')) {
          const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
          if (decoded && decoded.id) userId = decoded.id;
        }
      } catch {}
      if (!userId) {
        try {
          const mcpToken = req.headers['x-mcp-token'];
          if (mcpToken) {
            const verified = verifyMcpToken(mcpToken);
            if (verified && verified.userId) userId = verified.userId;
          }
        } catch {}
      }
      db.prepare('INSERT INTO visitor_detail_logs (ip, path, user_agent, referer, source, user_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(ip, req.path, req.headers['user-agent'] || null, req.headers['referer'] || null, source, userId);
    }
  } catch (err) {
    console.error('[Visitor Track] 数据库写入失败:', err.message);
  }
}

function getVisitorCounts() {
  try {
    ensureVisitorDb();
    const db = getIntelDb().getDb();
    const today = getTodayCST();
    const todayUV = db.prepare('SELECT COUNT(*) as cnt FROM visitor_logs WHERE date = ?').get(today).cnt;
    const totalVisits = db.prepare('SELECT COUNT(DISTINCT ip) as cnt FROM visitor_logs').get().cnt;
    const result = { online: onlineMap.size, todayUV, totalVisits };
    console.log('[Visitor Stats]', result);
    return result;
  } catch (err) {
    console.error('[Visitor Stats] 查询失败:', err.message);
    return { online: onlineMap.size, todayUV: 0, totalVisits: 0 };
  }
}

app.use((req, res, next) => { trackVisitor(req); next(); });

// ===== Health check =====
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', port: PORT });
});

// ===== 访问统计接口（公开，不需要 token）=====
app.get('/api/stats/visitors', (req, res) => {
  res.json(getVisitorCounts());
});

// ===== 调试端点：查看访问统计详情（需要 API token）=====
app.get('/api/debug/visitors', (req, res) => {
  try {
    ensureVisitorDb();
    const db = getIntelDb().getDb();
    const today = getTodayCST();
    const todayLogs = db.prepare('SELECT ip, first_visit_at FROM visitor_logs WHERE date = ? ORDER BY first_visit_at DESC').all(today);
    const allLogs = db.prepare('SELECT COUNT(*) as cnt FROM visitor_logs').get().cnt;
    res.json({
      online: onlineMap.size,
      onlineIPs: Array.from(onlineMap.keys()),
      todayCount: todayLogs.length,
      todayLogs,
      totalRecords: allLogs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 验证访问码 =====
app.post('/api/auth/verify', (req, res) => {
  const { key } = req.body || {};
  if (key === ACCESS_KEY) {
    res.json({ valid: true, level: 'full' });
  } else {
    res.json({ valid: false, level: 'public' });
  }
});

// ===== 注册 =====
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度 2-20 位' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  try {
    ensureAuthDb();
    const db = getIntelDb().getDb();
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exists) return res.status(409).json({ error: '用户名已存在' });
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, 'beta');
    const token = jwt.sign({ id: result.lastInsertRowid, username, role: 'beta' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username, role: 'beta' });
  } catch (err) { console.error('Register error:', err); res.status(500).json({ error: '注册失败' }); }
});

// ===== 登录 =====
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  try {
    ensureAuthDb();
    const db = getIntelDb().getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return res.status(401).json({ error: '用户名或密码错误' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: '用户名或密码错误' });
    const role = user.role || 'beta';
    const token = jwt.sign({ id: user.id, username: user.username, role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username, role });
  } catch (err) { console.error('Login error:', err); res.status(500).json({ error: '登录失败' }); }
});

// ===== 用户信息 =====
app.get('/api/user/profile', requireAuth, (req, res) => {
  try {
    ensureAuthDb();
    const db = getIntelDb().getDb();
    const user = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== MCP Token 列表 =====
app.get('/api/user/mcp-tokens', requireAuth, (req, res) => {
  try {
    ensureAuthDb();
    const db = getIntelDb().getDb();
    const tokens = db.prepare(
      'SELECT id, name, token, scopes, created_at, last_used_at, is_active FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC'
    ).all(req.user.id);
    res.json(tokens.map(t => ({
      ...t,
      tokenPreview: t.token.slice(0, 16) + '...',
      scopes: t.scopes ? t.scopes.split(',') : ['interview-intel'],
    })));
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== 创建 MCP Token =====
app.post('/api/user/mcp-tokens', requireAuth, (req, res) => {
  const { name, scopes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Token 名称不能为空' });
  const validScopes = ['interview-intel']; // 后续扩展在这里加
  const scopeList = Array.isArray(scopes) ? scopes.filter(s => validScopes.includes(s)) : ['interview-intel'];
  if (scopeList.length === 0) return res.status(400).json({ error: '请至少选择一个有效的授权范围' });
  try {
    ensureAuthDb();
    const db = getIntelDb().getDb();
    const count = db.prepare('SELECT COUNT(*) as cnt FROM mcp_tokens WHERE user_id = ? AND is_active = 1').get(req.user.id).cnt;
    if (count >= 5) return res.status(400).json({ error: '最多创建 5 个 Token' });
    const rand = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const token = `tiaozi-${req.user.username.slice(0, 4)}-${rand}`.slice(0, 40);
    db.prepare('INSERT INTO mcp_tokens (user_id, token, name, scopes) VALUES (?, ?, ?, ?)').run(req.user.id, token, name, scopeList.join(','));
    res.json({ token, name, scopes: scopeList, message: '请保存此 Token，关闭后不再显示完整内容' });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== 删除 MCP Token =====
app.delete('/api/user/mcp-tokens/:id', requireAuth, (req, res) => {
  try {
    ensureAuthDb();
    const db = getIntelDb().getDb();
    const token = db.prepare('SELECT id FROM mcp_tokens WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!token) return res.status(404).json({ error: 'Token not found' });
    db.prepare('UPDATE mcp_tokens SET is_active = 0 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== 用户自己的 MCP 调用统计 =====
app.get('/api/user/mcp-stats', requireAuth, (req, res) => {
  try {
    ensureAuthDb();
    const db = getIntelDb().getDb();
    const byTool = db.prepare(
      'SELECT tool_name, COUNT(*) as count, MAX(called_at) as last_called FROM mcp_call_logs WHERE user_id = ? GROUP BY tool_name ORDER BY count DESC'
    ).all(req.user.id);
    const recent = db.prepare(
      'SELECT tool_name, params, called_at FROM mcp_call_logs WHERE user_id = ? ORDER BY called_at DESC LIMIT 50'
    ).all(req.user.id);
    const total = db.prepare('SELECT COUNT(*) as cnt FROM mcp_call_logs WHERE user_id = ?').get(req.user.id).cnt;
    res.json({ total, byTool, recent });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== 管理员：用户列表 =====
app.get('/api/admin/users', requireAdmin, (req, res) => {
  try {
    ensureAuthDb();
    const db = getIntelDb().getDb();
    const users = db.prepare(
      'SELECT id, username, role, created_at FROM users ORDER BY created_at DESC'
    ).all();
    // 附加每个用户的 MCP 调用次数和 token 数
    const result = users.map(u => {
      const callCount = db.prepare('SELECT COUNT(*) as cnt FROM mcp_call_logs WHERE user_id = ?').get(u.id).cnt;
      const tokenCount = db.prepare('SELECT COUNT(*) as cnt FROM mcp_tokens WHERE user_id = ? AND is_active = 1').get(u.id).cnt;
      return normalizeTimestamps({ ...u, callCount, tokenCount });
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== 管理员：修改用户角色 =====
app.patch('/api/admin/users/:id/role', requireAdmin, (req, res) => {
  const { role } = req.body || {};
  if (!['user', 'beta', 'admin'].includes(role)) return res.status(400).json({ error: '无效角色' });
  try {
    ensureAuthDb();
    const db = getIntelDb().getDb();
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== 管理员：全量 MCP 调用日志 =====
app.get('/api/admin/mcp-logs', requireAdmin, (req, res) => {
  try {
    ensureAuthDb();
    const db = getIntelDb().getDb();
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const logs = db.prepare(`
      SELECT l.id, l.tool_name, l.params, l.called_at, l.token,
             u.username, u.role
      FROM mcp_call_logs l
      LEFT JOIN users u ON l.user_id = u.id
      ORDER BY l.called_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset).map(normalizeTimestamps);
    const total = db.prepare('SELECT COUNT(*) as cnt FROM mcp_call_logs').get().cnt;
    const byTool = db.prepare(
      'SELECT tool_name, COUNT(*) as count, MAX(called_at) as last_called FROM mcp_call_logs GROUP BY tool_name ORDER BY count DESC'
    ).all().map(normalizeTimestamps);
    res.json({ total, logs, byTool });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== 管理员：访客统计总览 =====
app.get('/api/admin/visitor-stats', requireAdmin, (req, res) => {
  try {
    ensureVisitorDb();
    const db = getIntelDb().getDb();
    const today = getTodayCST();

    // 在线 IP 列表（附带关联用户名）
    const onlineIPs = Array.from(onlineMap.entries()).map(([ip, ts]) => {
      let username = null;
      try {
        const row = db.prepare('SELECT u.username FROM visitor_detail_logs d JOIN users u ON d.user_id = u.id WHERE d.ip = ? AND d.user_id IS NOT NULL ORDER BY d.visited_at DESC LIMIT 1').get(ip);
        if (row) username = row.username;
      } catch {}
      return { ip, lastActive: new Date(ts).toISOString(), username };
    });

    // 今日 UV
    const todayUV = db.prepare('SELECT COUNT(*) as cnt FROM visitor_logs WHERE date = ?').get(today).cnt;
    // 总 UV
    const totalUV = db.prepare('SELECT COUNT(DISTINCT ip) as cnt FROM visitor_logs').get().cnt;
    // 总 PV（详细日志条数）
    const totalPV = db.prepare('SELECT COUNT(*) as cnt FROM visitor_detail_logs').get().cnt;
    // 今日 PV
    const todayPV = db.prepare("SELECT COUNT(*) as cnt FROM visitor_detail_logs WHERE visited_at >= ?").get(today).cnt;

    // 最近 7 天趋势
    const trend = db.prepare(`
      SELECT date, COUNT(*) as uv FROM visitor_logs
      WHERE date >= date('now', '-7 days')
      GROUP BY date ORDER BY date
    `).all();

    // 今日访客详情（IP + 首次访问 + 请求数 + 关联用户名）
    const todayVisitors = db.prepare(`
      SELECT v.ip, v.first_visit_at,
        (SELECT COUNT(*) FROM visitor_detail_logs d WHERE d.ip = v.ip AND d.visited_at >= ?) as request_count,
        (SELECT d.user_agent FROM visitor_detail_logs d WHERE d.ip = v.ip ORDER BY d.visited_at DESC LIMIT 1) as user_agent,
        (SELECT d.path FROM visitor_detail_logs d WHERE d.ip = v.ip ORDER BY d.visited_at DESC LIMIT 1) as last_path,
        (SELECT u.username FROM visitor_detail_logs d JOIN users u ON d.user_id = u.id WHERE d.ip = v.ip AND d.user_id IS NOT NULL ORDER BY d.visited_at DESC LIMIT 1) as username
      FROM visitor_logs v WHERE v.date = ?
      ORDER BY v.first_visit_at DESC
    `).all(today, today);

    res.json({ online: onlineIPs, todayUV, totalUV, todayPV, totalPV, trend, todayVisitors: todayVisitors.map(normalizeTimestamps) });
  } catch (err) { 
    console.error('Admin visitor-stats error:', err.message, err.stack); 
    res.status(500).json({ error: err.message || 'Failed' }); 
  }
});

// ===== 管理员：单个 IP 的访问历史 =====
app.get('/api/admin/visitor-detail', requireAdmin, (req, res) => {
  try {
    const ip = req.query.ip;
    if (!ip) return res.status(400).json({ error: 'Missing ip parameter' });
    ensureVisitorDb();
    const db = getIntelDb().getDb();

    // 该 IP 的访问天数
    const days = db.prepare('SELECT date, first_visit_at FROM visitor_logs WHERE ip = ? ORDER BY date DESC LIMIT 30').all(ip);
    // 该 IP 的最近请求
    const recentRequests = db.prepare('SELECT path, user_agent, referer, source, visited_at FROM visitor_detail_logs WHERE ip = ? ORDER BY visited_at DESC LIMIT 100').all(ip);
    // 该 IP 的总请求数
    const totalRequests = db.prepare('SELECT COUNT(*) as cnt FROM visitor_detail_logs WHERE ip = ?').get(ip).cnt;
    // 该 IP 的路径分布
    const pathStats = db.prepare('SELECT path, COUNT(*) as count FROM visitor_detail_logs WHERE ip = ? GROUP BY path ORDER BY count DESC LIMIT 20').all(ip);
    // 是否已封禁
    const banned = isIpBanned(ip);
    // 关联用户名
    const userRow = db.prepare('SELECT u.username FROM visitor_detail_logs d JOIN users u ON d.user_id = u.id WHERE d.ip = ? AND d.user_id IS NOT NULL ORDER BY d.visited_at DESC LIMIT 1').get(ip);
    const username = userRow ? userRow.username : null;

    res.json({ ip, totalRequests, banned, username, visitDays: days.map(normalizeTimestamps), recentRequests: recentRequests.map(normalizeTimestamps), pathStats });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== 管理员：封禁 IP =====
app.post('/api/admin/ban-ip', requireAdmin, (req, res) => {
  try {
    const { ip, reason } = req.body || {};
    if (!ip) return res.status(400).json({ error: 'Missing ip' });
    banIp(ip, reason || '管理员手动封禁');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== 管理员：解封 IP =====
app.post('/api/admin/unban-ip', requireAdmin, (req, res) => {
  try {
    const { ip } = req.body || {};
    if (!ip) return res.status(400).json({ error: 'Missing ip' });
    getIpBanDb().prepare('DELETE FROM ip_bans WHERE ip = ?').run(ip);
    console.log(`[Admin] IP 解封: ${ip}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== 管理员：封禁列表 =====
app.get('/api/admin/banned-ips', requireAdmin, (req, res) => {
  try {
    const rows = getIpBanDb().prepare('SELECT ip, banned_at, reason FROM ip_bans ORDER BY banned_at DESC').all();
    res.json(rows.map(normalizeTimestamps));
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== 管理员：用户行为详情 =====
app.get('/api/admin/user-behavior', requireAdmin, (req, res) => {
  try {
    ensureAuthDb();
    const db = getIntelDb().getDb();

    // 每个用户的 MCP 调用统计 + 最近活跃时间
    const users = db.prepare(`
      SELECT u.id, u.username, u.role, u.created_at,
        (SELECT COUNT(*) FROM mcp_call_logs l WHERE l.user_id = u.id) as call_count,
        (SELECT COUNT(*) FROM mcp_tokens t WHERE t.user_id = u.id AND t.is_active = 1) as token_count,
        (SELECT MAX(l.called_at) FROM mcp_call_logs l WHERE l.user_id = u.id) as last_active,
        (SELECT GROUP_CONCAT(DISTINCT l.tool_name) FROM mcp_call_logs l WHERE l.user_id = u.id) as tools_used
      FROM users u ORDER BY call_count DESC
    `).all();

    // 每日 MCP 调用趋势（最近 7 天，包含所有调用）
    const mcpTrend = db.prepare(`
      SELECT DATE(called_at) as date, COUNT(*) as count
      FROM mcp_call_logs
      WHERE called_at >= datetime('now', '-7 days')
      GROUP BY DATE(called_at) ORDER BY date
    `).all();

    // 匿名调用统计（user_id 为 null 的，即全局 token 调用）
    const anonymousCalls = db.prepare('SELECT COUNT(*) as cnt FROM mcp_call_logs WHERE user_id IS NULL').get().cnt;
    const anonymousByTool = db.prepare(
      'SELECT tool_name, COUNT(*) as count FROM mcp_call_logs WHERE user_id IS NULL GROUP BY tool_name ORDER BY count DESC'
    ).all();

    // 总调用数
    const totalCalls = db.prepare('SELECT COUNT(*) as cnt FROM mcp_call_logs').get().cnt;

    res.json({ users: users.map(normalizeTimestamps), mcpTrend, anonymousCalls, anonymousByTool, totalCalls });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== 面经情报总览 =====
function handleIntelOverview(req, res) {
  try {
    const db = getIntelDb();
    const stats = db.getStats();

    const companies = stats.byCompany.map(c => {
      const interviewCount = db.getDb().prepare(
        'SELECT COUNT(*) as cnt FROM interviews WHERE company_id = ?'
      ).get(c.company).cnt;
      const modules = db.getDb().prepare(
        'SELECT DISTINCT module FROM questions WHERE company_id = ?'
      ).all(c.company).map(r => r.module);
      return {
        id: c.company, name: c.name,
        interviews: interviewCount, questions: c.count, modules, lastCrawled: null,
      };
    });

    const matrixRows = db.getDb().prepare(
      'SELECT company_id, module, COUNT(*) as cnt FROM questions GROUP BY company_id, module'
    ).all();
    const matrix = {};
    const moduleSet = new Set();
    for (const r of matrixRows) {
      if (!matrix[r.company_id]) matrix[r.company_id] = {};
      matrix[r.company_id][r.module] = r.cnt;
      moduleSet.add(r.module);
    }
    const modules = [...moduleSet].sort();

    const diffMap = { 1: 'basic', 2: 'basic', 3: 'intermediate', 4: 'advanced', 5: 'advanced' };
    const difficulty = {};
    for (const [k, v] of Object.entries(stats.byDifficulty)) {
      const label = diffMap[k] || k;
      difficulty[label] = (difficulty[label] || 0) + v;
    }
    const types = {};
    for (const s of stats.byStyle) types[s.style] = s.count;

    res.json({
      totalQuestions: stats.totalQuestions, totalInterviews: stats.totalInterviews,
      companiesCollected: stats.totalCompanies, totalCompanies: stats.totalCompanies,
      modulesCollected: modules.length, companies, matrix, modules, difficulty, types, daily: [],
    });
  } catch (err) { console.error('Intel overview error:', err); res.status(500).json({ error: 'Failed' }); }
}
app.get('/api/intel/overview', handleIntelOverview);

// ===== 提取进度 =====
app.get('/api/intel/pending', (req, res) => {
  try {
    const db = getIntelDb();
    const extractionStats = db.getExtractionStats();
    const rawDir = path.resolve(PROJECT_DIR, 'skill/data/raw');
    const result = [];
    const companies = db.getDb().prepare('SELECT id, name FROM companies').all();
    for (const c of companies) {
      const companyDir = path.join(rawDir, c.id);
      let totalFiles = 0;
      try { totalFiles = readdirSync(companyDir).filter(f => f.endsWith('.md')).length; } catch {}
      const dbEntry = extractionStats.byCompany?.find(b => b.company_id === c.id);
      const extracted = dbEntry ? dbEntry.done : 0;
      const pending = totalFiles - extracted - (dbEntry ? dbEntry.skipped : 0);
      result.push({ id: c.id, name: c.name, total: totalFiles, pending: Math.max(0, pending), extracted });
    }
    res.json(result);
  } catch (err) { console.error('Intel pending error:', err); res.status(500).json({ error: 'Failed' }); }
});

// ===== 热点话题 =====
function handleHotTopics(req, res) {
  try {
    const db = getIntelDb();
    const byModule = db.getHotTopics();
    const trending = db.getTrendingTopics(15);
    const companies = db.getDb().prepare('SELECT id FROM companies').all();
    const byCompany = {};
    for (const c of companies) {
      const profiles = db.getCompanyProfile(c.id);
      if (!profiles || profiles.length === 0) continue;
      const topModules = profiles.slice(0, 3).map(p => p.module);
      const patterns = profiles.slice(0, 1).flatMap(p => (p.commonFollowUps || []).slice(0, 3));
      byCompany[c.id] = { style: profiles.length > 3 ? '全面考察' : '重点突破', topModules, uniquePatterns: patterns };
    }
    res.json({ lastUpdated: new Date().toISOString(), byModule, byCompany, trending: trending.map(t => ({ topic: t.topic, module: t.module })) });
  } catch (err) { console.error('Hot topics error:', err); res.status(500).json({ error: 'Failed' }); }
}
app.get('/api/hot-topics', handleHotTopics);

// ===== 公司画像 =====
function handleCompanyProfile(req, res) {
  try {
    const company = req.params.company;
    const db = getIntelDb();
    const profiles = db.getCompanyProfile(company);
    if (!profiles || profiles.length === 0) return res.status(404).json({ error: 'Company data not found' });
    const slimProfiles = profiles.map(p => ({
      module: p.module,
      question_count: p.question_count,
      topTopics: (p.topTopics || []).slice(0, 5),
      difficultyDist: p.difficultyDist,
      commonFollowUps: (p.commonFollowUps || []).slice(0, 5),
    }));
    res.json({ profiles: slimProfiles });
  } catch (err) { console.error('Interview intel error:', err); res.status(500).json({ error: 'Failed' }); }
}
app.get('/api/interview-intel/:company', handleCompanyProfile);

// ===== 题目列表（多维筛选 + 分页，按权限脱敏）=====
function handleIntelQuestions(req, res) {
  try {
    const db = getIntelDb();
    const filters = {};
    if (req.query.module) filters.module = req.query.module;
    if (req.query.company) filters.company = req.query.company;
    if (req.query.style) filters.style = req.query.style;
    if (req.query.depth) filters.depth = req.query.depth;
    if (req.query.difficulty) filters.difficulty = parseInt(req.query.difficulty);
    if (req.query.round) filters.round = parseInt(req.query.round);
    if (req.query.keyword) filters.keyword = req.query.keyword;
    if (req.query.kp) filters.knowledgePoints = req.query.kp.split(',');
    if (req.query.fts) filters.fts = req.query.fts;
    if (req.query.position) filters.position = req.query.position;
    if (req.query.recruitType) filters.recruitType = req.query.recruitType;
    filters.limit = Math.min(parseInt(req.query.limit) || 30, 100);
    filters.offset = parseInt(req.query.offset) || 0;

    // detail 级别：summary=只返回标题/元数据, normal=加摘要(默认), full=完整内容
    const detail = req.query.detail || 'normal';

    const questions = db.queryQuestions(filters);
    let total = questions.length;
    if (questions.length === filters.limit || filters.offset > 0) {
      const dbRaw = db.getDb();
      const conditions = [];
      const params = {};
      if (filters.module) { conditions.push('q.module = @module'); params.module = filters.module; }
      if (filters.company) { conditions.push('q.company_id = @company'); params.company = filters.company; }
      if (filters.style) { conditions.push('q.question_style = @style'); params.style = filters.style; }
      if (filters.depth) { conditions.push('q.depth_level = @depth'); params.depth = filters.depth; }
      if (filters.difficulty) { conditions.push('q.difficulty = @difficulty'); params.difficulty = filters.difficulty; }
      if (filters.round) { conditions.push('q.round = @round'); params.round = filters.round; }
      if (filters.keyword) { conditions.push('(q.topic LIKE @keyword OR q.content LIKE @keyword)'); params.keyword = `%${filters.keyword}%`; }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      total = dbRaw.prepare(`SELECT COUNT(*) as cnt FROM questions q ${where}`).get(params).cnt;
    }

    // 按 detail 级别裁剪字段
    const applyDetail = (q) => {
      const base = { id: q.id, topic: q.topic, module: q.module, company: q.company_name, round: q.round, difficulty: q.difficulty, style: q.question_style };
      if (detail === 'summary') return base;
      // normal：返回完整 content + kp列表（前端用 line-clamp 截断显示）
      if (detail === 'normal') return { ...base, content: q.content || '', company_id: q.company_id || q.company_name, kps: (q.knowledgePoints || []).slice(0, 5), followUpCount: (q.followUps || []).length };
      // full：完整内容（仅 full accessLevel 时返回 answer_hint）
      const full = { ...base, content: q.content, kps: q.knowledgePoints, followUps: (q.followUps || []).map(f => f.content || f) };
      if (req.accessLevel === 'full') full.answer_hint = q.answer_hint;
      return full;
    };

    const sanitized = questions.map(applyDetail);
    res.json({ questions: sanitized, total, limit: filters.limit, offset: filters.offset, detail });
  } catch (err) { console.error('Intel questions error:', err); res.status(500).json({ error: 'Failed' }); }
}
app.get('/api/intel/questions', handleIntelQuestions);

// ===== 单题详情（按权限脱敏）=====
function handleQuestionDetail(req, res) {
  try {
    const db = getIntelDb();
    const trace = db.getQuestionTrace(parseInt(req.params.id));
    if (!trace) return res.status(404).json({ error: 'Question not found' });
    if (trace.relations && trace.relations.length > 0) {
      const rawDb = db.getDb();
      const stmtQ = rawDb.prepare('SELECT id, content, topic, module, company_id, difficulty, question_style FROM questions WHERE id = ?');
      trace.relations = trace.relations.map(r => {
        const rq = stmtQ.get(r.relatedId);
        if (rq) { r.content = rq.content; r.topic = rq.topic; r.module = rq.module; r.company_id = rq.company_id; r.difficulty = rq.difficulty; r.question_style = rq.question_style; }
        return r;
      });
    }
    if (req.accessLevel !== 'full') {
      delete trace.raw_content;
      if (trace.trace) { delete trace.trace.source_url; delete trace.trace.raw_file; }
    }
    res.json(trace);
  } catch (err) { console.error('Question detail error:', err); res.status(500).json({ error: 'Failed' }); }
}
app.get('/api/intel/questions/:id', handleQuestionDetail);

// ===== 原始面经内容（仅 full 权限）=====
app.get('/api/intel/raw', (req, res) => {
  if (req.accessLevel !== 'full') return res.status(403).json({ error: 'Access denied' });
  try {
    const company = req.query.company;
    const filename = req.query.filename;
    if (!company || !filename) return res.status(400).json({ error: 'Missing company or filename' });
    if (String(company).includes('..') || String(filename).includes('..')) return res.status(400).json({ error: 'Invalid path' });
    const filePath = path.join(PROJECT_DIR, 'skill/data/raw', String(company), String(filename));
    if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    const content = readFileSync(filePath, 'utf-8');
    res.json({ company, filename, content });
  } catch (err) { console.error('Raw file error:', err); res.status(500).json({ error: 'Failed' }); }
});

// ===== 面经列表（按权限脱敏）=====
app.get('/api/intel/interviews', (req, res) => {
  try {
    const db = getIntelDb().getDb();
    const conditions = [];
    const params = {};
    if (req.query.company) { conditions.push('i.company_id = @company'); params.company = req.query.company; }
    if (req.query.level) { conditions.push('i.level = @level'); params.level = req.query.level; }
    if (req.query.result) { conditions.push('i.result = @result'); params.result = req.query.result; }
    if (req.query.keyword) { conditions.push('(i.title LIKE @keyword OR i.department LIKE @keyword)'); params.keyword = `%${req.query.keyword}%`; }
    if (req.query.hasRounds) { conditions.push('i.rounds >= @hasRounds'); params.hasRounds = parseInt(req.query.hasRounds); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const offset = parseInt(req.query.offset) || 0;
    // full 模式返回全部字段，public 模式不返回 source/source_url/raw_file
    const selectFields = req.accessLevel === 'full'
      ? 'i.*, c.name as company_name'
      : `i.id, i.company_id, i.title, i.published_at, i.level, i.department,
         i.rounds, i.result, i.experience_years, i.education, c.name as company_name`;
    const rows = db.prepare(`
      SELECT ${selectFields},
        (SELECT COUNT(*) FROM questions q WHERE q.interview_id = i.id) as question_count
      FROM interviews i JOIN companies c ON c.id = i.company_id
      ${where} ORDER BY i.published_at DESC LIMIT ${limit} OFFSET ${offset}
    `).all(params);
    const total = db.prepare(`SELECT COUNT(*) as cnt FROM interviews i ${where}`).get(params).cnt;
    res.json({ interviews: rows, total, limit, offset });
  } catch (err) { console.error('Intel interviews error:', err); res.status(500).json({ error: 'Failed' }); }
});

// ===== 单篇面经详情（按权限脱敏）=====
app.get('/api/intel/interviews/:id', (req, res) => {
  try {
    const db = getIntelDb();
    const rawDb = db.getDb();
    const interview = rawDb.prepare(`
      SELECT i.*, c.name as company_name
      FROM interviews i JOIN companies c ON c.id = i.company_id
      WHERE i.id = ?
    `).get(req.params.id);
    if (!interview) return res.status(404).json({ error: 'Interview not found' });

    // 获取该面经下的所有题目
    const questions = rawDb.prepare(`
      SELECT id, module, topic, content, difficulty, question_style, depth_level, round, answer_hint, sort_order
      FROM questions WHERE interview_id = ? ORDER BY sort_order
    `).all(req.params.id);

    // 为每道题附加知识点和追问链
    const stmtKP = rawDb.prepare('SELECT knowledge_point FROM question_knowledge_points WHERE question_id = ?');
    const stmtFU = rawDb.prepare('SELECT id, follow_up as content, sort_order, parent_id as parentId, depth FROM question_follow_ups WHERE question_id = ? ORDER BY sort_order');
    const enriched = questions.map(q => ({
      ...q,
      knowledgePoints: stmtKP.all(q.id).map(r => r.knowledge_point),
      followUps: stmtFU.all(q.id),
    }));

    // public 模式：去掉 source/source_url/raw_file
    const result = { ...interview, questions: enriched };
    if (req.accessLevel !== 'full') {
      delete result.source;
      delete result.source_url;
      delete result.raw_file;
    }

    res.json(result);
  } catch (err) { console.error('Interview detail error:', err); res.status(500).json({ error: 'Failed' }); }
});

// ===== 维度查询（前端全局筛选栏）=====
app.get('/api/intel/dimensions', (req, res) => {
  try {
    const db = getIntelDb();
    const dims = db.getDimensions();
    res.json(dims);
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== 贡献 API =====

// 贡献限额检查（100条/天/用户）
function checkContributeLimit(userId) {
  const db = getIntelDb().getDb();
  const today = getTodayCST();
  const count = db.prepare(`
    SELECT COUNT(*) as cnt FROM interviews
    WHERE contributor_id = ? AND DATE(created_at) = ?
  `).get(userId, today).cnt;
  return count < 100;
}

// POST /api/contribute/upload — 批量上传面经
app.post('/api/contribute/upload', requireAuth, (req, res) => {
  const { interviews } = req.body || {};
  if (!Array.isArray(interviews) || interviews.length === 0) {
    return res.status(400).json({ error: 'interviews 数组不能为空' });
  }
  if (interviews.length > 20) {
    return res.status(400).json({ error: '单次最多上传 20 篇' });
  }
  // 5MB 限制
  const bodySize = JSON.stringify(req.body).length;
  if (bodySize > 5 * 1024 * 1024) {
    return res.status(413).json({ error: '请求体超过 5MB 限制' });
  }
  if (!checkContributeLimit(req.user.id)) {
    return res.status(429).json({ error: '今日贡献已达上限（100条/天）' });
  }

  const db = getIntelDb();
  const rawDb = db.getDb();
  let accepted = 0;
  let skipped = 0;
  const errors = [];

  for (const iv of interviews) {
    try {
      // 基础校验
      if (!iv.companyId || !iv.title || !Array.isArray(iv.questions) || iv.questions.length === 0) {
        errors.push({ id: iv.id, reason: '缺少必填字段(companyId/title/questions)' });
        continue;
      }

      // content_hash 去重
      const hash = iv.contentHash;
      if (hash) {
        const existing = db.findInterviewByHash(hash);
        if (existing) {
          // 记录贡献者但不重复插入
          db.addContributor(existing.id, req.user.id);
          skipped++;
          continue;
        }
      }

      // 确保公司存在
      const existingCompany = db.getCompany(iv.companyId);
      if (!existingCompany) {
        db.upsertCompany({ id: iv.companyId, name: iv.companyId, aliases: [], searchKeywords: [] });
      }

      // 插入面经
      const interviewId = iv.id || `contrib-${req.user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      db.insertInterview({
        id: interviewId,
        companyId: iv.companyId,
        title: iv.title,
        sourceUrl: iv.sourceUrl || null,
        publishedAt: iv.publishedAt || null,
        position: iv.position || null,
        recruitType: iv.recruitType || null,
        contentHash: hash || null,
        contributorId: req.user.id,
        sourceType: 'contributed',
        trustLevel: 'new',
        questions: (iv.questions || []).map(q => ({
          module: q.module || 'other',
          topic: q.topic || '未知',
          type: q.type || null,
          difficulty: q.difficulty || null,
          content: q.content || null,
          answerHint: q.answerHint || null,
          round: q.round || null,
          knowledgePoints: q.knowledgePoints || [],
          followUps: q.followUps || [],
        })),
      });
      db.addContributor(interviewId, req.user.id);
      accepted++;
    } catch (e) {
      errors.push({ id: iv.id, reason: e.message });
    }
  }

  res.json({ accepted, skipped, errors: errors.slice(0, 10) });
});

// GET /api/contribute/stats — 当前用户贡献统计
app.get('/api/contribute/stats', requireAuth, (req, res) => {
  try {
    const db = getIntelDb().getDb();
    const total = db.prepare('SELECT COUNT(*) as cnt FROM interviews WHERE contributor_id = ?').get(req.user.id).cnt;
    const today = getTodayCST();
    const todayCount = db.prepare("SELECT COUNT(*) as cnt FROM interviews WHERE contributor_id = ? AND DATE(created_at) = ?").get(req.user.id, today).cnt;
    const byCompany = db.prepare('SELECT company_id, COUNT(*) as cnt FROM interviews WHERE contributor_id = ? GROUP BY company_id ORDER BY cnt DESC LIMIT 10').all(req.user.id);
    res.json({ total, today: todayCount, remaining: Math.max(0, 100 - todayCount), byCompany });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// GET /api/contribute/leaderboard — 贡献排行榜（公开）
app.get('/api/contribute/leaderboard', (req, res) => {
  try {
    const db = getIntelDb().getDb();
    const rows = db.prepare(`
      SELECT u.username, COUNT(i.id) as total,
             MAX(i.created_at) as last_contributed
      FROM interviews i
      JOIN users u ON u.id = i.contributor_id
      WHERE i.source_type = 'contributed'
      GROUP BY i.contributor_id
      ORDER BY total DESC LIMIT 20
    `).all();
    res.json(rows.map(normalizeTimestamps));
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== MCP 专用 API（轻量查询，供 MCP Server 远程调用）=====
// MCP 路由支持全局 token 或用户级 MCP token，需要 interview-intel scope
app.use('/api/mcp', (req, res, next) => {
  const auth = req.headers['authorization'] || '';
  const token = (auth.startsWith('Bearer ') ? auth.slice(7) : null)
    || req.headers['x-api-token']
    || req.query._token;
  const caller = verifyMcpToken(token);
  if (!caller) return res.status(401).json({ error: 'Invalid MCP token' });
  if (!caller.scopes.includes('*') && !caller.scopes.includes('interview-intel')) {
    return res.status(403).json({ error: 'Token does not have interview-intel scope' });
  }
  // 记录 REST API 调用日志（从路径提取工具名）
  const toolName = req.path.replace(/^\//, '').replace(/\//g, '_') || 'unknown';
  const params = { ...req.query };
  delete params._token; // 不记录 token
  logMcpCall(caller.userId, caller.token, `rest:${toolName}`, params);
  next();
});

// ===== /api/mcp/ 版本的公共接口（走 MCP 鉴权）=====
app.get('/api/mcp/overview', handleIntelOverview);
app.get('/api/mcp/hot-topics', handleHotTopics);
app.get('/api/mcp/company-profile/:company', handleCompanyProfile);
app.get('/api/mcp/questions', handleIntelQuestions);
app.get('/api/mcp/questions/:id', handleQuestionDetail);
app.get('/api/mcp/dimensions', (req, res) => {
  try { res.json(getIntelDb().getDimensions()); }
  catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/mcp/frequency-rank', (req, res) => {
  try {
    const db = getIntelDb();
    const module = req.query.module || null;
    const limit = Math.min(parseInt(req.query.limit) || 30, 50);
    let result = db.getFrequencyRank(module);
    // 后端截断 + 字段精简，防止全量数据撑爆 MCP 上下文
    result = result.slice(0, limit).map(r => ({
      kp: r.knowledgePoint,
      count: r.count,
      company_count: Array.isArray(r.companies) ? r.companies.length : 0,
    }));
    res.json(result);
  } catch (err) { console.error('MCP frequency-rank error:', err); res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/mcp/follow-up-patterns', (req, res) => {
  try {
    if (!req.query.kp) return res.status(400).json({ error: 'Missing kp parameter' });
    const db = getIntelDb();
    const result = db.getFollowUpPatterns(req.query.kp);
    const detail = req.query.detail || 'normal';

    // summary：只返回追问关键词骨架（每步截取前20字）
    // normal：追问文本截60字，top10（默认）
    // full：完整追问文本，top15
    const maxPatterns = detail === 'full' ? 15 : 10;
    const textLen = detail === 'summary' ? 20 : detail === 'full' ? 999 : 60;

    const slim = {
      knowledgePoint: result.knowledgePoint,
      totalQuestions: result.totalQuestions,
      patterns: (result.patterns || []).slice(0, maxPatterns).map(p => ({
        path: (p.path || []).map(s => s?.slice(0, textLen)),
        frequency: p.frequency,
        ...(detail !== 'summary' && { maxDepth: p.maxDepth }),
      })),
    };
    res.json(slim);
  } catch (err) { console.error('MCP follow-up-patterns error:', err); res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/mcp/combo-patterns', (req, res) => {
  try {
    if (!req.query.kp) return res.status(400).json({ error: 'Missing kp parameter' });
    const db = getIntelDb();
    const result = db.getComboPatterns(req.query.kp, parseInt(req.query.limit) || 10);
    // 裁剪：去掉 sampleInterviews（对 AI 无用）
    const slim = {
      anchor: result.anchor,
      totalAnchorQuestions: result.totalAnchorQuestions,
      combos: (result.combos || []).map(c => ({
        next: c.next, module: c.module,
        probability: c.probability, avgGap: c.avgGap,
        knowledgePoints: (c.knowledgePoints || []).slice(0, 3),
      })),
    };
    res.json(slim);
  } catch (err) { console.error('MCP combo-patterns error:', err); res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/mcp/trend', (req, res) => {
  try {
    if (!req.query.kp) return res.status(400).json({ error: 'Missing kp parameter' });
    const db = getIntelDb();
    const result = db.getTrendTimeline(req.query.kp, req.query.granularity || 'quarter');
    // 裁剪：timeline 只保留最近 6 个周期
    const slim = {
      knowledgePoint: result.knowledgePoint,
      trend: result.trend,
      peakPeriod: result.peakPeriod,
      timeline: (result.timeline || []).slice(-6),
    };
    res.json(slim);
  } catch (err) { console.error('MCP trend error:', err); res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/mcp/round-analysis', (req, res) => {
  try {
    const db = getIntelDb();
    const result = db.getRoundAnalysis(req.query.module || null, req.query.company || null);
    // 裁剪：每轮只保留 top5 topics 和 top3 styles
    const slim = { module: result.module, company: result.company, byRound: {} };
    for (const [round, info] of Object.entries(result.byRound || {})) {
      slim.byRound[round] = {
        count: info.count, avgDifficulty: info.avgDifficulty,
        topTopics: (info.topTopics || []).slice(0, 5),
        topStyles: (info.topStyles || []).slice(0, 3),
      };
    }
    res.json(slim);
  } catch (err) { console.error('MCP round-analysis error:', err); res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/mcp/cross-company', (req, res) => {
  try {
    const db = getIntelDb();
    const result = db.getCrossCompanyTopics(
      parseInt(req.query.minCompanies) || 3,
      parseInt(req.query.limit) || 20
    );
    // 裁剪：companies 只保留数量，去掉完整数组
    const slim = result.map(r => ({
      topic: r.topic,
      module: r.module,
      frequency: r.frequency,
      company_count: r.company_count,
      trend: r.trend,
    }));
    res.json(slim);
  } catch (err) { console.error('MCP cross-company error:', err); res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/mcp/experience-analysis', (req, res) => {
  try {
    const db = getIntelDb();
    const result = db.getExperienceAnalysis(req.query.module || null);
    // 裁剪：每个年限段只保留 top5 模块
    const slim = { module: result.module, byExperience: {} };
    for (const [exp, info] of Object.entries(result.byExperience || {})) {
      slim.byExperience[exp] = {
        count: info.count, avgDifficulty: info.avgDifficulty,
        topModules: (info.topModules || []).slice(0, 5),
      };
    }
    res.json(slim);
  } catch (err) { console.error('MCP experience-analysis error:', err); res.status(500).json({ error: 'Failed' }); }
});

// ===== MCP HTTP Server (Streamable HTTP, stateless) =====
function buildMcpServer(caller = null, logFn = null) {
  const server = new McpServer({ name: 'interview-intel', version: '1.0.0' });
  const log = (toolName, params) => logFn && caller && logFn(caller.userId, caller.token, toolName, params);
  const txt = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

  server.tool('stats', '面经数据库概览：总题数、公司数、模块分布', {}, async () => {
    log('stats', {});
    const s = getIntelDb().getStats();
    return txt({ totalQuestions: s.totalQuestions, totalInterviews: s.totalInterviews, companies: s.totalCompanies, byModule: s.byModule });
  });

  server.tool('hot_topics', '各模块高频考点排名', {
    module: z.string().optional().describe('模块名：mysql/redis/concurrent/jvm/java-basic/kafka/mq'),
  }, async ({ module }) => {
    log('hot_topics', { module });
    const data = getIntelDb().getHotTopics(null, module || null);
    return txt(module ? { [module]: data[module] } : data);
  });

  server.tool('frequency_rank', '知识点在面经中的出现频次排名', {
    module: z.string().optional().describe('模块名'),
  }, async ({ module }) => { log('frequency_rank', { module }); return txt(getIntelDb().getFrequencyRank(module || null)); });

  server.tool('follow_up_patterns', '某知识点的真实追问路径', {
    kp: z.string().describe('知识点，如"间隙锁"、"线程池"、"MVCC"'),
  }, async ({ kp }) => { log('follow_up_patterns', { kp }); return txt(getIntelDb().getFollowUpPatterns(kp)); });

  server.tool('combo_patterns', '问完某知识点后面试官接着问什么', {
    kp: z.string().describe('知识点'),
    limit: z.number().optional().describe('返回数量，默认 10'),
  }, async ({ kp, limit }) => { log('combo_patterns', { kp, limit }); return txt(getIntelDb().getComboPatterns(kp, limit || 10)); });

  server.tool('trend', '知识点考察趋势（rising/stable/declining）', {
    kp: z.string().describe('知识点'),
    granularity: z.enum(['quarter', 'month']).optional(),
  }, async ({ kp, granularity }) => { log('trend', { kp, granularity }); return txt(getIntelDb().getTrendTimeline(kp, granularity || 'quarter')); });

  server.tool('round_analysis', '一面/二面/三面分别考什么', {
    module: z.string().optional(),
    company: z.string().optional().describe('公司 ID，如 alibaba/bytedance/meituan'),
  }, async ({ module, company }) => { log('round_analysis', { module, company }); return txt(getIntelDb().getRoundAnalysis(module || null, company || null)); });

  server.tool('cross_company', '被多家公司共同考察的高频知识点', {
    min_companies: z.number().optional().describe('最少覆盖公司数，默认 3'),
    limit: z.number().optional().describe('返回数量，默认 20'),
  }, async ({ min_companies, limit }) => { log('cross_company', { min_companies, limit }); return txt(getIntelDb().getCrossCompanyTopics(min_companies || 3, limit || 20)); });

  server.tool('company_profile', '某公司的面试风格画像', {
    company: z.string().describe('公司 ID：alibaba/bytedance/meituan/pdd/ctrip/baidu/tencent'),
  }, async ({ company }) => {
    log('company_profile', { company });
    const profiles = getIntelDb().getCompanyProfile(company);
    // 裁剪：只保留核心画像，去掉完整题目列表
    const slim = (profiles || []).slice(0, 8).map(p => ({
      module: p.module,
      question_count: p.question_count,
      topTopics: (p.topTopics || []).slice(0, 5),
      difficultyDist: p.difficultyDist,
      commonFollowUps: (p.commonFollowUps || []).slice(0, 5),
    }));
    return txt(slim);
  });

  server.tool('experience_analysis', '不同工作年限被考察内容的差异', {
    module: z.string().optional(),
  }, async ({ module }) => { log('experience_analysis', { module }); return txt(getIntelDb().getExperienceAnalysis(module || null)); });

  server.tool('search_questions', '搜索面经题目（多维筛选）', {
    module: z.string().optional(),
    company: z.string().optional(),
    kp: z.string().optional().describe('知识点关键词，逗号分隔'),
    keyword: z.string().optional(),
    limit: z.number().optional().describe('默认 10，最大 30'),
  }, async ({ module, company, kp, keyword, limit }) => {
    log('search_questions', { module, company, kp, keyword, limit });
    const filters = { limit: Math.min(limit || 10, 30) };
    if (module) filters.module = module;
    if (company) filters.company = company;
    if (keyword) filters.keyword = keyword;
    if (kp) filters.knowledgePoints = kp.split(',');
    const qs = getIntelDb().queryQuestions(filters);
    return txt(qs.map(q => ({ id: q.id, topic: q.topic, module: q.module, company: q.company_name, content: q.content, knowledgePoints: q.knowledgePoints })));
  });

  server.tool('study_guide', '根据目标公司/模块生成学习优先级建议', {
    company: z.string().optional().describe('目标公司 ID'),
    module: z.string().optional().describe('目标模块'),
  }, async ({ company, module }) => {
    log('study_guide', { company, module });
    const db = getIntelDb();
    // mustKnow：只保留核心字段，去掉 companies 数组（太长）
    const must = db.getCrossCompanyTopics(5, 15).map(r => ({
      module: r.module, topic: r.topic, frequency: r.frequency,
      companyCount: r.company_count, trend: r.trend,
    }));
    const guide = { mustKnow: must };
    if (module) {
      const hot = db.getHotTopics(null, module)?.[module]?.topQuestions?.slice(0, 10);
      guide.moduleHot = hot?.map(q => ({ topic: q.topic, frequency: q.frequency, companyCount: q.companyCount }));
    }
    if (company) {
      guide.companyFocus = db.getCompanyProfile(company)?.slice(0, 5).map(p => ({
        module: p.module, question_count: p.question_count,
        topTopics: (p.topTopics || []).slice(0, 5),
        commonFollowUps: (p.commonFollowUps || []).slice(0, 3),
      }));
    }
    return txt(guide);
  });

  return server;
}

// MCP 端点：Bearer token 鉴权 + stateless transport（每次请求独立）
app.post('/mcp', async (req, res) => {
  const auth = req.headers['authorization'] || '';
  const rawToken = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
  const caller = verifyMcpToken(rawToken);
  if (!caller) {
    return res.status(401).json({ error: 'Invalid or missing MCP token. Get your token at http://106.54.196.46:4173 → 个人中心' });
  }
  if (!caller.scopes.includes('*') && !caller.scopes.includes('interview-intel')) {
    return res.status(403).json({ error: 'Token does not have interview-intel scope. Please create a token with interview-intel scope.' });
  }
  // 包装 buildMcpServer，在每个 tool 调用时记录日志
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpServer = buildMcpServer(caller, logMcpCall);
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[MCP] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'MCP server error' });
  }
});

// MCP GET（SSE 订阅，stateless 模式返回 405）
app.get('/mcp', (req, res) => {
  res.status(405).json({ error: 'Stateless MCP server does not support GET/SSE. Use POST.' });
});

// ===== 静态文件 + SPA fallback =====
const distPath = path.resolve(__dirname, '../frontend/dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[IntelSite] 服务启动: http://localhost:${PORT}`);
  console.log(`[IntelSite] 访问统计接口: GET /api/stats/visitors`);
  console.log(`[IntelSite] 调试端点: GET /api/debug/visitors (需要 API token)`);
  // 初始化访问统计表
  try {
    ensureVisitorDb();
    console.log('[IntelSite] 访问统计数据库已初始化');
  } catch (err) {
    console.error('[IntelSite] 访问统计数据库初始化失败:', err.message);
  }
  // 初始化用户认证表
  try {
    ensureAuthDb();
    console.log('[IntelSite] 用户认证数据库已初始化');
  } catch (err) {
    console.error('[IntelSite] 用户认证数据库初始化失败:', err.message);
  }
});
