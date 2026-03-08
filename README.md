# interview-intel-open

面经情报站开源版 — AI 驱动的面经采集 Skill + 后端 Server + MCP Server

## 接入 AI 查询（推荐，零安装）

在你的 AI 工具（Cursor / Kiro / Claude Desktop）的 MCP 配置中添加：

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

在 [tiaozi.site](https://tiaozi.site) 注册账号获取 Token，然后直接问 AI：

- 「字节跳动面试风格是什么？」
- 「MySQL 哪些知识点考得最多？」
- 「帮我制定 Redis 复习计划」

## 贡献数据（AI 驱动，无需手动执行脚本）

1. **Clone 到本地，用 Kiro 打开**
   ```bash
   git clone https://github.com/NoSuchClass/interview-intel-open
   ```

2. **直接跟 AI 对话**，AI 会自动完成所有操作：
   > 「帮我爬取字节跳动和美团的面经，我是 Java 社招」

   AI 会自动：检查环境 → 生成 profile → 执行爬虫 → 提取结构化数据

3. **推送到公共库**（在 tiaozi.site 获取 Token）：
   > 「帮我推送数据，我的 token 是 xxx」

详细的 AI 行为指南见 [skill/SKILL.md](skill/SKILL.md)。

## 目录结构

```
interview-intel-open/
├── skill/          ← AI 驱动的爬虫 Skill
│   ├── SKILL.md    ← AI 行为指南（意图识别 + 工作流）
│   ├── scripts/    ← 爬虫脚本（由 AI 调用，无需手动执行）
│   └── templates/  ← profile 模板
├── server/         ← 后端 Server（自部署用）
├── mcp/            ← MCP Server 源码
└── docs/
```

## License

MIT
