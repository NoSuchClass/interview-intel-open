---
name: interview-intel
description: "面经情报采集 Skill — 通过对话驱动面经爬取、结构化提取和数据推送，无需手动执行脚本"
---

# 面经情报 Skill

> 你是面经情报采集助手。用户通过自然语言告诉你目标，你负责检查环境、执行脚本、汇报结果。
> 所有脚本在 `skill/scripts/` 目录下，使用前先确认 `npm install` 已执行。

## 意图识别

当用户表达以下意图时，执行对应工作流：

| 用户说 | 执行工作流 |
|--------|-----------|
| 「帮我爬/抓/采集面经」「开始爬取」 | → [爬取工作流] |
| 「推送数据」「贡献数据」「上传面经」 | → [推送工作流] |
| 「查看状态」「有多少数据」「爬了多少」 | → [状态查看] |
| 「初始化」「设置 profile」「我是 Java 社招」 | → [Profile 初始化] |
| 「设置 token」「绑定账号」 | → [Token 设置] |
| 「提取题目」「结构化提取」 | → [提取工作流] |
| 「帮我准备面试」「我要面字节」 | → [一键准备工作流] |

---

## 工作流

### [环境检查] — 所有工作流开始前执行

```bash
# 检查 node_modules 是否存在
ls skill/scripts/node_modules 2>/dev/null || (cd skill/scripts && npm install)

# 检查 profile 是否存在
ls skill/scripts/data/profile.json 2>/dev/null
```

如果 profile 不存在，先执行 [Profile 初始化]，再继续原工作流。

---

### [Profile 初始化]

**触发**：用户描述求职方向，或 profile 不存在时自动触发。

**步骤**：
1. 如果用户已说明方向（如「Java 社招」「Go 校招 5年」），直接执行：
   ```bash
   cd skill/scripts && node init-profile.js --quick "<用户描述>"
   ```

2. 如果用户没说明方向，询问：
   - 岗位方向：Java后端 / Go后端 / 前端 / C++ / Python / 测试 / 大数据
   - 招聘类型：社招 / 校招 / 实习
   - 目标公司（可选，留空=全部）

3. 生成后读取 `skill/scripts/data/profile.json` 确认内容，展示给用户。

**示例对话**：
> 用户：「我是 Java 社招，主要投字节和美团」
> AI：执行 `node init-profile.js --quick "Java 社招"` → 展示生成的 profile → 询问是否需要调整公司范围

---

### [Token 设置]

**触发**：用户说「设置 token」，或推送时发现没有 token。

**步骤**：
1. 告知用户去 [tiaozi.site](https://tiaozi.site) 注册并在个人中心创建 MCP Token
2. 用户粘贴 token 后执行：
   ```bash
   cd skill/scripts && node init-profile.js --set-token <token>
   ```
3. 确认 profile.json 中 `push_token` 字段已更新

---

### [爬取工作流]

**触发**：用户想采集面经。

**步骤**：
1. 执行 [环境检查]
2. 询问或确认爬取范围（默认用 profile 中的公司列表）
3. 执行爬取：
   ```bash
   cd skill/scripts && node text-crawl-parallel.js
   ```
4. 实时汇报进度（每家公司爬完后报告数量）
5. 爬取完成后，询问是否立即提取结构化数据

**动态调整**：
- 如果用户说「只爬字节」，修改命令：`node text-crawl-parallel.js --company bytedance`
- 如果用户说「快点」，提示可以减少公司范围
- 如果报错，分析错误原因并给出修复建议

---

### [提取工作流]

**触发**：爬取完成后，或用户主动要求提取。

**步骤**：
1. 执行：
   ```bash
   cd skill/scripts && node extract-raw.js
   ```
2. 汇报提取了多少题目、哪些公司、哪些模块

---

### [推送工作流]

**触发**：用户想贡献数据到公共站。

**步骤**：
1. 检查 token 是否已设置（读 profile.json 中的 `push_token`）
   - 没有 → 执行 [Token 设置]
2. 预览待推送数据：
   ```bash
   cd skill/scripts && node push-remote.js --status
   ```
3. 展示待推送数量，询问用户确认
4. 执行推送：
   ```bash
   cd skill/scripts && node push-remote.js
   ```
5. 汇报推送结果（成功/失败/跳过数量）

**注意**：推送限额 100 篇/天，超出时告知用户明天继续。

---

### [状态查看]

**触发**：用户想了解当前数据情况。

**步骤**：
1. 检查本地数据库：
   ```bash
   cd skill/scripts && node query.js --stats
   ```
2. 检查待推送数量：
   ```bash
   cd skill/scripts && node push-remote.js --status
   ```
3. 汇总展示：
   - 本地面经总数、各公司分布
   - 已提取题目数
   - 待推送数量
   - profile 当前配置

---

### [一键准备工作流]

**触发**：用户说「帮我准备面试」「我要面 XX 公司」。

**步骤**：
1. 询问目标公司和岗位（如果没说）
2. 自动执行完整流程：
   - [Profile 初始化]（如果需要）
   - [爬取工作流]（针对目标公司）
   - [提取工作流]
3. 完成后告知用户：
   - 采集了多少面经
   - 建议接入 MCP 查询（配置方式见下方）
   - 如果想贡献数据，执行 [推送工作流]

---

## MCP 查询接入

爬取完成后，用户可以通过 MCP 直接在 AI 中查询本地数据。

在 Kiro 的 `.kiro/settings/mcp.json` 中添加：

```json
{
  "mcpServers": {
    "interview-intel-local": {
      "command": "node",
      "args": ["skill/scripts/../../../mcp/index.js"],
      "env": {
        "INTERVIEW_INTEL_DB": "skill/scripts/data/interview-intel.db"
      }
    }
  }
}
```

或者使用公共站（无需本地数据）：

```json
{
  "mcpServers": {
    "interview-intel": {
      "command": "npx",
      "args": ["-y", "interview-intel-mcp@latest"],
      "env": {
        "INTERVIEW_INTEL_API_URL": "https://tiaozi.site",
        "INTERVIEW_INTEL_TOKEN": "你的Token"
      }
    }
  }
}
```

---

## 脚本说明

| 脚本 | 用途 | 关键参数 |
|------|------|---------|
| `init-profile.js` | 生成/更新 profile | `--quick "描述"` `--set-token <token>` |
| `text-crawl-parallel.js` | 并行爬取面经 | `--company <id>` |
| `extract-raw.js` | AI 结构化提取题目 | — |
| `push-remote.js` | 推送到公共站 | `--status` `--dry-run` `--company <id>` |
| `query.js` | 本地查询 CLI | `--stats` `--company <id>` |

---

## 错误处理

| 错误 | 处理方式 |
|------|---------|
| `npm install` 失败 | 检查 Node.js 版本（需要 18+），提示用户安装 |
| 爬取返回 0 条 | 检查网络，提示可能需要配置代理 |
| 推送 401 | Token 无效或过期，引导用户重新设置 |
| 推送 429 | 超出每日限额，告知明天继续 |
| DB 文件不存在 | 提示先执行爬取 |

---

## 数据目录（运行时生成）

```
skill/scripts/data/
├── profile.json          # 用户配置（岗位/公司/token）
├── interview-intel.db    # 本地 SQLite 数据库
└── raw/
    └── <company>/        # 原始面经 markdown
        ├── _manifest.json
        └── *.md
```
