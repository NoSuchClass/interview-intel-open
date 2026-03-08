# interview-intel-open

面经情报站开源版 — 爬虫 Skill + 后端 Server + MCP Server

## 快速开始

### 接入 AI 查询（推荐）

无需本地部署，直接用 npx 接入：

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

在 [tiaozi.site](https://tiaozi.site) 注册账号获取 Token，支持 Cursor / Kiro / Claude Desktop 等所有 MCP 工具。

### 贡献数据

```bash
# 1. clone 并安装依赖
git clone https://github.com/NoSuchClass/interview-intel-open
cd interview-intel-open/skill/scripts && npm install

# 2. 一句话生成 profile
node init-profile.js --quick "Java 社招"

# 3. 绑定 Token（在 tiaozi.site 个人中心获取）
node init-profile.js --set-token YOUR_TOKEN

# 4. 爬取并推送
node text-crawl-parallel.js
node push-remote.js
```

## 目录结构

```
interview-intel-open/
├── skill/          ← 爬虫 Skill（本地采集 + 推送）
│   ├── SKILL.md
│   ├── scripts/    ← 爬虫脚本
│   └── templates/  ← profile 模板
├── server/         ← 后端 Server（自部署用）
├── mcp/            ← MCP Server 源码
└── docs/
```

## License

MIT
