---
name: interview-intel
description: "Interview Intelligence Skill — conversationally driven interview report crawling, structured extraction, and data contribution. No manual scripting required."
---

# Interview Intelligence Skill

> You are an interview intelligence assistant. The user tells you their goal in natural language; you check the environment, run scripts, and report results.
> All scripts live under `skill/scripts/`. Always confirm `npm install` has been run before executing any script.

## Intent Recognition

| User says | Workflow |
|-----------|----------|
| "crawl / scrape / collect interview reports" | → [Crawl Workflow] |
| "push data" / "contribute data" / "upload reports" | → [Push Workflow] |
| "check status" / "how much data" / "what's been crawled" | → [Status Check] |
| "initialize" / "set profile" / "I'm a Java experienced hire" | → [Profile Init] |
| "set token" / "bind account" | → [Token Setup] |
| "extract questions" / "structured extraction" / "process reports" | → [Extraction Workflow] |
| "help me prep for interviews" / "I'm interviewing at ByteDance" | → [One-Click Prep] |
| "first time" / "how to install" / "install browser" / "log in to Nowcoder" / "log in to Xiaohongshu" | → [Browser Environment Setup] |

---

## Workflows

### [Environment Check] — run before every workflow

```bash
# Check node_modules
ls skill/scripts/node_modules 2>/dev/null || (cd skill/scripts && npm install)

# Check profile
ls skill/scripts/data/profile.json 2>/dev/null
```

If profile is missing, run [Profile Init] first, then resume the original workflow.
If this is the first time, also run [Browser Environment Setup].

---

### [Browser Environment Setup] — one-time setup

**Why it's needed**: Platforms like Nowcoder require a logged-in session. Playwright uses a persistent browser profile to store cookies — log in once and all future crawls reuse the session automatically.

**Steps**:

1. Install the Playwright browser (~160 MB, one-time only):
   ```bash
   cd skill/scripts && npx playwright install chromium
   ```

2. First-time login to Nowcoder (opens a real browser window):
   ```bash
   cd skill/scripts && node nowcoder-worker.js --worker 0 --tasks '[{"companyId":"bytedance","keywords":["ByteDance interview"],"limit":1}]'
   ```
   When the browser opens, log in manually (QR code or username/password). The script resumes automatically after login.

3. Login state is saved at `~/.agent-browser-profile` (under your home directory).
   - This is Playwright's persistent context directory — contains cookies, localStorage, etc.
   - All future crawls reuse this profile. **No re-login needed.**
   - Each platform uses its own profile directory:
     - Nowcoder: `~/.agent-browser-profile`
     - CSDN: `~/.agent-browser-profile-csdn`
     - Juejin: `~/.agent-browser-profile-juejin`
     - Xiaohongshu: `~/.agent-browser-profile-xhs-data/xiaohongshu`

4. Verify login: run the command again — if no login page appears and crawling starts directly, the session is valid.

**Xiaohongshu (Little Red Book) login** — separate step required before first XHS crawl:

```bash
cd skill/scripts && node xhs-crawl-parallel.js --login
```

A browser window opens. Log in manually (QR code scan). Once done, press `Ctrl+C` to close. Login state is saved to `~/.agent-browser-profile-xhs-data/xiaohongshu`.

For parallel crawling with multiple workers, copy the login state to worker profiles after logging in:

```bash
cd skill/scripts && node xhs-crawl-parallel.js --init-workers 3
```

**Notes**:
- If cookies expire (typically after a few months), just re-run step 2 to log in again.
- `headless: false` keeps the browser window visible, making it easy to handle CAPTCHAs or QR codes.
- Do not delete `~/.agent-browser-profile` — doing so requires re-login.

---

### [Profile Init]

**Trigger**: user describes their job search direction, or profile is missing.

**Steps**:
1. If the user has already stated their direction (e.g. "Java experienced hire", "Go campus recruit"), run directly:
   ```bash
   cd skill/scripts && node init-profile.js --quick "<user description>"
   ```

2. If no direction given, ask:
   - Role: Java Backend / Go Backend / Frontend / C++ / Python / QA / Big Data
   - Hire type: Experienced / Campus / Intern
   - Target companies (optional — leave blank for all)

3. After generation, read `skill/scripts/data/profile.json` and show the user a summary.

**Example**:
> User: "I'm a Java experienced hire, mainly targeting ByteDance and Meituan"
> AI: runs `node init-profile.js --quick "Java experienced hire"` → shows profile → asks if company list needs adjustment

---

### [Token Setup]

**Trigger**: user says "set token", or push fails due to missing token.

**Steps**:
1. Tell the user to register at [tiaozi.site](https://tiaozi.site) and create an MCP Token in their profile.
2. After the user pastes the token:
   ```bash
   cd skill/scripts && node init-profile.js --set-token <token>
   ```
3. Confirm the `token` field in `profile.json` is updated.

---

### [Crawl Workflow]

**Trigger**: user wants to collect interview reports.

**Steps**:
1. Run [Environment Check].
2. Confirm crawl scope (defaults to companies in profile).
3. Start crawling:
   ```bash
   cd skill/scripts && node text-crawl-parallel.js --all --limit 5
   ```
4. Report progress after each company finishes.
5. After crawling, ask if the user wants to run structured extraction immediately.

**Dynamic adjustments**:
- "Only crawl ByteDance" → `node text-crawl-parallel.js --companies bytedance --limit 5`
- "Faster" → reduce company scope
- On error → analyze and suggest a fix

**Crawl priority** (based on local data volume):

| Questions in DB | Limit per company | Notes |
|-----------------|-------------------|-------|
| < 50 | 15 | Critically low — prioritize |
| 50–99 | 10 | Low |
| 100–199 | 7 | Moderate |
| ≥ 200 | 5 | Sufficient — maintenance crawl |

---

### [Extraction Workflow]

**Trigger**: after crawling, or user explicitly requests extraction.

> This workflow is driven by the AI assistant in the current conversation (Kiro, Cursor, Claude, etc.) — no external API calls are made.
> The script only reads files and writes to DB. The AI does the actual extraction inline.

**Steps**:

1. Check pending files:
   ```bash
   node extract-raw.js --dry
   ```

2. Get the next batch of prompts:
   ```bash
   node extract-raw.js --list [companyId]
   ```
   Returns a JSON array. Each item has `systemPrompt`, `userPrompt` (report body, up to 4000 chars), `file`, `companyId`.

3. For each item: the AI reads `systemPrompt` + `userPrompt` directly in this conversation and produces the structured JSON result.

4. Write the result to DB:
   ```bash
   node extract-raw.js --save <companyId> <fileName> --file <result.json>
   ```
   On success: `{"ok":true,"questions":N,"level":"P6","total":M}`.
   Progress is auto-recorded in `extraction_log` — no manual tracking needed.

5. Repeat steps 2–4 until `--dry` shows 0 pending.

6. Report final stats:
   ```bash
   node query.js --stats
   ```

#### Extraction Rules (built into systemPrompt)

**Atomic splitting**: if one numbered item contains multiple independent knowledge points (multiple question marks, "and also", "as well as"), split into separate records.

Exceptions — do NOT split:
- Project deep-dives: consecutive follow-ups on the same project → 1 record, `type: project-deep-dive`
- Algorithm questions: problem + optimization follow-ups → 1 record
- System design: full design question + detail follow-ups → 1 record

**Required fields per question**:

| Field | Description |
|-------|-------------|
| `module` | Knowledge domain (see Module Reference below) |
| `topic` | Normalized topic name |
| `type` | `八股` / `场景设计` / `代码题` / `系统设计` / `追问链` / `project-deep-dive` |
| `questionStyle` | One of 24 styles (see Style Reference below) |
| `depthLevel` | `surface` / `mechanism` / `source` / `design` |
| `difficulty` | `1`–`5` integer string (see Difficulty Reference below) |
| `content` | Normalized question text |
| `rawContent` | Interviewer's exact words |
| `answerHint` | Key answer points (brief, for AI reference) |
| `round` | Interview round number (integer, default 1) |
| `followUps` | Array of `{content, parentIndex, depth}` objects |
| `knowledgePoints` | kebab-case identifiers |

**Interview-level metadata** (top-level fields alongside `questions`):

- `rounds`: total rounds recorded in this report
- `result`: `pass` / `fail` / `unknown`
- `experienceYears`: string like `"3"`, `"3-5"`, `"5+"`, or `null`
- `education`: `"本科"` / `"硕士"` / `"博士"` / `null`

**Multi-company reports**: if one file contains interviews from multiple companies, extract each company separately and call `--save` once per company with the same filename but different `companyId`.

**Non-interview content**: return `{"skip": true, "reason": "..."}` — the script auto-records this as skipped.

**HR round questions**: extract them normally. Use `module: hr`, set `difficulty` based on topic complexity (1 for intro/salary/resignation, 2 for career planning, 3 for team collaboration cases).

#### Module Reference (17 modules — no new modules allowed)

| module | Domain |
|--------|--------|
| `mysql` | MySQL / databases |
| `concurrent` | Concurrent programming |
| `java-basic` | Java basics / collections / design patterns |
| `redis` | Redis / caching |
| `jvm` | JVM |
| `spring` | Spring / frameworks |
| `algorithm` | Algorithms / coding problems |
| `network` | Networking / Netty |
| `system-design` | System design / scenario questions |
| `distributed` | Distributed systems |
| `mq` | Message queues (general) |
| `microservice` | Microservices |
| `kafka` | Kafka (dedicated) |
| `os` | Operating systems |
| `hr` | HR / soft skills |
| `project` | Project experience |
| `other` | DevOps / security / Elasticsearch / misc |

#### Difficulty Reference (integer strings only — no P5/P6/P7, no decimals)

| Value | Meaning | Base rule |
|-------|---------|-----------|
| `"1"` | Introductory | HR topics: intro / salary / resignation |
| `"2"` | Basic | `depthLevel: surface`; HR: career planning |
| `"3"` | Intermediate | `depthLevel: mechanism`; coding problems |
| `"4"` | Advanced | `depthLevel: source` or `design` |
| `"5"` | Hard | Architecture-level design |

Style adjustments: `source-code` / `system-design` / `project-deep-dive` / `optimization` / `trade-off` / `reliability` / `data-consistency` → +1; `concept` / `experience` / `workflow` → −1.

#### Question Style Reference (24 values — no others allowed)

`concept` `principle` `source-code` `comparison` `scenario` `troubleshoot` `coding` `system-design` `best-practice` `trade-off` `anti-pattern` `experience` `cross-domain` `evolution` `project-deep-dive` `implementation` `optimization` `boundary` `why-not` `workflow` `config-tuning` `monitoring` `reliability` `data-consistency`

---

### [Push Workflow]

**Trigger**: user wants to contribute data to the public site.

**Steps**:
1. Check if token is set in `profile.json`.
   - Missing → run [Token Setup] first.
2. Preview pending data:
   ```bash
   cd skill/scripts && node push-remote.js --status
   ```
3. Show pending count, ask user to confirm.
4. Push:
   ```bash
   cd skill/scripts && node push-remote.js
   ```
5. Report results (accepted / failed / skipped-duplicate counts).

**Note**: daily push limit is 100 reports. If exceeded, inform the user to continue tomorrow.

---

### [Status Check]

**Trigger**: user wants to know the current data situation.

**Steps**:
1. Local DB stats:
   ```bash
   cd skill/scripts && node query.js --stats
   ```
2. Pending push count:
   ```bash
   cd skill/scripts && node push-remote.js --status
   ```
3. Show a summary:
   - Total local reports and per-company breakdown
   - Total extracted questions
   - Pending push count
   - Current profile config

---

### [One-Click Prep]

**Trigger**: user says "help me prep for interviews" or "I'm interviewing at [company]".

**Steps**:
1. Ask for target company and role if not stated.
2. Run the full pipeline automatically:
   - [Profile Init] (if needed)
   - [Crawl Workflow] (scoped to target company)
   - [Extraction Workflow]
3. Report completion:
   - How many reports were collected
   - Suggest connecting via MCP for querying (see MCP section below)
   - Offer to run [Push Workflow] to contribute data

---

## MCP Query Integration

After crawling, connect via MCP to query your local data directly inside AI.

Add to `.kiro/settings/mcp.json`:

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

Or use the public site (no local data needed):

```json
{
  "mcpServers": {
    "interview-intel": {
      "command": "npx",
      "args": ["-y", "interview-intel-mcp@latest"],
      "env": {
        "INTERVIEW_INTEL_API_URL": "https://tiaozi.site",
        "INTERVIEW_INTEL_TOKEN": "your-token-here"
      }
    }
  }
}
```

---

## Script Reference

| Script | Purpose | Key flags |
|--------|---------|-----------|
| `init-profile.js` | Create / update profile | `--quick "description"` `--set-token <token>` `--show` |
| `text-crawl-parallel.js` | Parallel crawl across platforms | `--all` `--companies <id,...>` `--sources <id,...>` `--limit N` |
| `xhs-crawl-parallel.js` | Xiaohongshu parallel crawl | `--login` `--init-workers N` `--all` `--companies <id,...>` `--workers N` `--limit N` |
| `extract-raw.js` | AI-driven structured extraction | `--dry` `--list [company]` `--save <co> <file> --file <json>` |
| `push-remote.js` | Push to public site | `--status` `--dry-run` `--company <id>` |
| `query.js` | Local query CLI | `--stats` `--query` `--hot-topics` |

---

## Error Handling

| Error | Resolution |
|-------|-----------|
| `npm install` fails | Check Node.js version (requires 18+) |
| `Executable doesn't exist` | Playwright browser not installed — run `npx playwright install chromium` |
| Login page appears during crawl | Cookies expired — log in manually in the browser window; session saved to `~/.agent-browser-profile` |
| Crawl returns 0 results | Check network / proxy; verify company names and keywords in profile |
| Push 401 | Token invalid or expired — re-run [Token Setup] |
| Push 429 | Daily limit reached — continue tomorrow |
| DB file missing | Run crawl + extraction first |

---

## Data Directory (generated at runtime)

```
skill/scripts/data/
├── profile.json           # User config (role / companies / token)
├── interview-intel.db     # Local SQLite database
└── raw/
    └── <company>/         # Raw interview report markdown files
        ├── _manifest.json
        └── *.md
```
