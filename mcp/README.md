# 面经情报 MCP Server

让你的 AI 助手（Kiro / Claude Desktop / Cursor 等）直接查询 Java 后端面经数据库。

数据来源：16 家大厂的真实面经，覆盖 MySQL、Redis、并发、JVM、Java 基础、Kafka、MQ、Spring 等模块。

## 快速开始（无需安装，纯 HTTP 接入）

### 第一步：获取 Token

访问 [面经情报站](http://106.54.196.46:4173) → 右上角登录 → 个人中心 → 创建 MCP Token

### 第二步：配置 AI 工具

**Kiro** (`.kiro/settings/mcp.json`):
```json
{
  "mcpServers": {
    "interview-intel": {
      "type": "http",
      "url": "http://106.54.196.46:4173/mcp",
      "headers": {
        "Authorization": "Bearer 你的Token"
      },
      "autoApprove": ["stats", "hot_topics", "frequency_rank",
        "follow_up_patterns", "combo_patterns", "trend",
        "round_analysis", "cross_company", "company_profile",
        "experience_analysis", "search_questions", "study_guide"]
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "interview-intel": {
      "type": "http",
      "url": "http://106.54.196.46:4173/mcp",
      "headers": {
        "Authorization": "Bearer 你的Token"
      }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "interview-intel": {
      "type": "http",
      "url": "http://106.54.196.46:4173/mcp",
      "headers": {
        "Authorization": "Bearer 你的Token"
      }
    }
  }
}
```

就这两步，无需 clone 仓库、无需本地安装任何东西。

## 可用工具

| 工具 | 说明 | 典型用法 |
|------|------|----------|
| `stats` | 数据概览 | "面经数据库有多少题？" |
| `hot_topics` | 高频考点 | "MySQL 哪些知识点最常考？" |
| `frequency_rank` | 知识点频次排名 | "并发模块知识点按频次排序" |
| `follow_up_patterns` | 追问链分析 | "间隙锁面试官通常怎么追问？" |
| `combo_patterns` | 组合拳分析 | "问完线程池接着问什么？" |
| `trend` | 趋势分析 | "MVCC 是越来越热还是降温了？" |
| `round_analysis` | 按面试轮次分析 | "一面和二面考的有什么区别？" |
| `cross_company` | 跨公司高频考点 | "哪些题被 5 家以上公司考过？" |
| `company_profile` | 公司面试风格 | "字节面试偏好考什么？" |
| `experience_analysis` | 按工作年限分析 | "3 年和 5 年经验面的题有什么不同？" |
| `search_questions` | 搜索面经题目 | "搜索 P6 难度的 Redis 场景设计题" |
| `question_detail` | 单题详情 | "看看这道题的完整追问链" |
| `study_guide` | 学习指南 | "我要面阿里，给个学习优先级建议" |

## 使用示例

直接用自然语言和你的 AI 对话即可：

- "帮我看看 MySQL 模块哪些是高频考点"
- "我准备面字节，应该重点准备什么？"
- "线程池这个知识点，面试官一般怎么追问？"
- "哪些知识点是所有大厂都会考的必考题？"
- "给我搜几道 P6 难度的并发场景设计题"

## 数据说明

- 数据来自牛客、掘金、小红书等平台的真实面经
- 覆盖 16 家公司：阿里、字节、美团、拼多多、携程、百度、腾讯等
- 持续更新中，欢迎反馈
