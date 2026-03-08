# interview-intel-open

面经情报站开源版 — AI 驱动的面经采集 Skill + MCP Server + 后端 Server

---

## 一、接入 AI 查询（推荐，零安装）

在你的 AI 工具的 MCP 配置中添加一行，即可直接用自然语言查询 5000+ 道真实面试题：

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

在 [tiaozi.site](https://tiaozi.site) 注册账号获取 Token。

**支持的 AI 工具**：

| 工具 | MCP 配置文件位置 |
|------|----------------|
| Kiro | `.kiro/settings/mcp.json` |
| Cursor | `~/.cursor/mcp.json` 或项目 `.cursor/mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| VS Code (Copilot) | `.vscode/mcp.json` |

配置后直接问 AI：
- 「字节跳动面试风格是什么？」
- 「MySQL 哪些知识点考得最多？」
- 「帮我制定 Redis 复习计划，我要面美团」

---

## 二、贡献面经数据（AI 驱动，无需手动执行脚本）

### 快速开始

```bash
git clone https://github.com/NoSuchClass/interview-intel-open
cd interview-intel-open
```

然后用你的 AI 工具打开这个目录，**直接对话**即可，AI 会自动完成所有操作。

### 不同工具的接入方式

**Kiro**（推荐，原生支持 Skill）

将 `skill/` 目录复制到你项目的 `.kiro/skills/interview-intel/`，Kiro 会自动加载 SKILL.md：

```bash
cp -r skill .kiro/skills/interview-intel
```

然后直接说：「帮我爬取字节跳动的面经，我是 Java 社招」

**Cursor**

在对话框中用 `@` 引用 SKILL.md：

```
@skill/SKILL.md 帮我爬取字节跳动的面经，我是 Java 社招
```

或在 `.cursor/rules/` 下创建规则文件，内容为 `@skill/SKILL.md`。

**Claude / 其他 AI**

直接把 `skill/SKILL.md` 的内容粘贴到对话开头，然后说你的需求。

### AI 会自动完成的事

1. 检查环境（Node.js、npm install）
2. 生成 profile（你的岗位方向、目标公司）
3. 执行爬虫（牛客、CSDN、小红书等）
4. 结构化提取（AI 直接在对话中完成，无需外部 API）
5. 推送到公共库（需要 Token）

详细的 AI 行为指南见 [skill/SKILL.md](skill/SKILL.md)。

---

## 三、自部署后端（可选）

如果你想搭建自己的私有面经库：

```bash
cd server
npm install
node server.js
```

MCP Server 指向本地：

```json
{
  "mcpServers": {
    "interview-intel-local": {
      "command": "node",
      "args": ["mcp/index.js"],
      "env": {
        "INTERVIEW_INTEL_API_URL": "http://localhost:3002",
        "INTERVIEW_INTEL_TOKEN": "your-token"
      }
    }
  }
}
```

---

## 目录结构

```
interview-intel-open/
├── skill/              ← AI 驱动的爬虫 Skill
│   ├── SKILL.md        ← AI 行为指南（意图识别 + 工作流）
│   ├── scripts/        ← 爬虫脚本（由 AI 调用）
│   └── templates/      ← profile 模板
├── mcp/                ← MCP Server 源码
├── server/             ← 后端 Server（自部署用）
└── docs/
```

## License

MIT
