# 面经情报 Skill

> 抓取各大平台面经，结构化提取题目，本地查询 + 可选推送到公共面经情报站。

## 快速开始

```bash
cd skill/scripts
npm install

# 1. 生成 profile（选择岗位/招聘类型/公司）
node init-profile.js

# 或一句话快速生成
node init-profile.js --quick "Go 社招"
node init-profile.js --quick "Java 社招 P6"
node init-profile.js --quick "前端 校招"

# 2. 开始抓取
node text-crawl-parallel.js

# 3. 提取结构化数据
node extract-raw.js

# 4. 本地查询（通过 MCP）
# 配置 mcp/index.js 后，在 Kiro 中直接问

# 5. 推送到公共站（可选）
node push-remote.js --status    # 查看待推送数量
node push-remote.js --dry-run   # 预览
node push-remote.js             # 实际推送
```

## Profile 配置

首次运行 `node init-profile.js` 会在 `data/profile.json` 生成配置文件。

支持的岗位方向：
- `java-backend` — Java 后端
- `go-backend` — Go 后端
- `frontend` — 前端
- `cpp` — C++
- `python` — Python
- `test` — 测试/测开
- `data` — 大数据
- `fullstack` — 全栈

支持的招聘类型：
- `social` — 社招
- `campus` — 校招
- `intern` — 实习

## 推送到公共站

1. 在 [面经情报站](http://106.54.196.46:4173) 注册账号
2. 个人中心 → 创建 MCP Token
3. 运行 `node init-profile.js --set-token <your-token>`
4. 运行 `node push-remote.js`

推送限额：100 篇/天，单次最多 20 篇，5MB/次。

## MCP 工具

配置好 `mcp/index.js` 后，可在 Kiro 中使用以下工具：

| 工具 | 说明 |
|------|------|
| `stats` | 数据库概览 |
| `hot_topics` | 模块高频考点 |
| `frequency_rank` | 知识点频次排名 |
| `follow_up_patterns` | 追问路径分析 |
| `combo_patterns` | 组合拳模式 |
| `trend` | 考察趋势 |
| `round_analysis` | 轮次分析 |
| `cross_company` | 跨公司必考点 |
| `company_profile` | 公司面试画像 |
| `experience_analysis` | 年限差异分析 |
| `search_questions` | 题目搜索 |
| `question_detail` | 单题详情 |
| `study_guide` | 学习优先级建议 |
| `push_data` | 推送数据到公共站 |
| `dimensions` | 查看维度列表 |

## 目录结构

```
skill/
├── SKILL.md
├── scripts/
│   ├── init-profile.js       # Profile 初始化
│   ├── crawl-common.js       # 爬取公共模块（profile 驱动）
│   ├── push-remote.js        # 推送到远程站
│   ├── db.js                 # SQLite 存储层
│   ├── extract-raw.js        # AI 结构化提取
│   ├── query.js              # 本地查询 CLI
│   ├── nowcoder-worker.js    # 牛客网爬虫
│   ├── csdn-crawl-worker.js  # CSDN 爬虫
│   ├── github-worker.js      # GitHub 爬虫
│   └── text-crawl-parallel.js # 并行爬取入口
├── templates/
│   ├── profile-java-social.json
│   ├── profile-go-social.json
│   ├── profile-frontend-campus.json
│   └── profile-all.json
└── data/                     # 运行时生成（gitignore）
    ├── profile.json
    ├── interview-intel.db
    └── raw/
        └── <company>/
            ├── _manifest.json
            └── *.md
```

## 数据维度

每篇面经和每道题都带有：
- `position` — 岗位方向（java-backend/go-backend/frontend/...）
- `recruit_type` — 招聘类型（social/campus/intern）

公共站支持按这两个维度全局筛选，贡献数据时请确保 profile 配置正确。
