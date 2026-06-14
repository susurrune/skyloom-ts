# Skyloom — 天空织机

<div align="center">

**≋ 雾 · ⸽ 雨 · ✱ 霜 · ❉ 雪 · ∘ 露 · ☼ 晴**

*六位 Agent，一支团队 —— 一座水墨气象台。*

[![CI](https://github.com/susurrune/skyloom-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/susurrune/skyloom-ts/actions)
[![npm](https://img.shields.io/npm/v/skyloom?color=c0392b)](https://www.npmjs.com/package/skyloom)
[![License: MIT](https://img.shields.io/badge/license-MIT-3a7a6e.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-3a7a6e)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-240%20passed-2ecc71)](https://github.com/susurrune/skyloom-ts/tree/main/tests)

</div>

---

**Skyloom** 是一个本地优先的多智能体终端框架。六个专职 Agent 通过事件总线、三层记忆与 DAG 编排引擎协作完成复杂工作流。它不是又一个 LLM 聊天包装器 —— 而是一个**分工明确、可观测、可审计的 AI 团队运行时**。

每个 Agent 对应一种天气、一味矿物颜料、一句古诗。这套贯穿 CLI、TUI 与 Web 的「水墨气象台」意象系统，是 Skyloom 的辨识度所在。设计理念详见 [美学设计系统](docs/AESTHETIC_DESIGN.md)。

---

## 目录

- [快速开始](#快速开始)
- [六灵 — Agent 体系](#六灵--agent-体系)
- [交互界面](#交互界面)
  - [立轴模式（默认）](#立轴模式默认)
  - [经典线性模式](#经典线性模式)
  - [Web UI](#web-ui)
- [命令与操作](#命令与操作)
- [核心架构](#核心架构)
  - [智能路由与编排](#智能路由与编排)
  - [三层记忆](#三层记忆)
  - [工具系统](#工具系统)
  - [安全体系](#安全体系)
  - [技能系统](#技能系统)
  - [MCP 双向桥](#mcp-双向桥)
- [工程化能力](#工程化能力)
- [支持的 LLM Provider](#支持的-llm-provider)
- [项目结构](#项目结构)
- [开发](#开发)
- [路线图](#路线图)
- [许可证](#许可证)

---

## 快速开始

```bash
npm install -g skyloom
sky
```

首次启动自动进入设置向导 —— 选 Provider → 输 API Key → 选模型，全部交互式完成。

- API Key 持久化于 `~/.skyloom/config.yaml`，更新不丢失
- 随时 `/setup` 重新切换 Provider 或模型
- 支持管道接入：`cat err.log | sky -p "归类错误"`

### 常用命令

| 命令 | 说明 |
|------|------|
| `sky` | 进入交互对话（全屏「立轴」水墨 TUI） |
| `sky --classic` | 线性滚动界面（管道 / 窄终端自动回退） |
| `sky fog` | 直接与指定 Agent 对话 |
| `sky task "写一个CLI"` | 多 Agent DAG 编排 |
| `sky web` | 启动 Web UI → `http://localhost:3000` |
| `sky mcp` | 启动 MCP Server（供 Claude Desktop 等调用） |
| `sky apikey set <provider> <key>` | 保存 API Key |
| `sky -p "问题" [--agent fog] [--json]` | Headless 模式（CI / 管道 / 外部编排） |

---

## 六灵 — Agent 体系

Skyloom 内置六个专职 Agent，各自拥有独立的系统提示、工具集、技能集与矿物色标识：

| Agent | 符号 | 矿物色 | 色值 | 职责定位 | 核心技能 |
|-------|------|--------|------|----------|----------|
| **雾** Fog | ≋ | 松烟墨 | `#4a4a44` | 探索洞察 — 调研、分析、信息提取 | `web_research`, `code_analysis` |
| **雨** Rain | ⸽ | 石青 | `#2a5c8a` | 创造产出 — 代码生成、内容写作 | `code_generator`, `content_writer` |
| **霜** Frost | ✱ | 石绿 | `#3a7a6e` | 精炼品质 — 代码审查、安全审计 | `code_reviewer`, `security_auditor` |
| **雪** Snow | ❉ | 铅白 | `#8a8a82` | 架构规划 — 任务分解、系统设计 | `task_planner`, `arch_designer` |
| **露** Dew | ∘ | 赭石 | `#8b6914` | 可靠守护 — 运维、CI/CD、部署 | `sys_operator`, `ci_cd_manager` |
| **晴** Fair | ☼ | 朱砂 | `#b3342d` | 情感陪伴 — 对话、自我进化 | `emotional_companion`, `self_evolve` |

Agent 之间可通过 `delegate_to` 工具相互委托子任务，也可通过事件总线异步协作。在多 Agent 编排中，**雪（Snow）** 担任规划者角色，将目标分解为 DAG 子任务后分派给各灵执行。

---

## 交互界面

### 立轴模式（默认）

`sky` 在真实终端中进入全屏**立轴**模式 —— 一座水墨气象台：

- **顶部印章**：随当前 Agent 切换矿物色
- **天幕**：气象粒子按灵的动势飘动（雾飘 · 雨落 · 霜结 · 雪降 · 露凝 · 晴升）
- **远山剪影**：随会话逐渐生长
- **左栏**：六灵常驻面板，多灵编排时亮起脉冲与 ✓/✗ 战绩
- **右侧正文**：真流式逐字「晕染」入场，差量重绘只刷新变化的行
- **织谱**：`/task` 多灵编排时逐梭列出子任务与依赖，原位更新状态与耗时

```
┌─ 天空织机 Skyloom ──────────────────────────────────────── 霧 ─┐
│ ≋        ≋      ≋  气象粒子        ≋          ≋               │
│ ▁▂▃▅▃▂▁▁▂▄▂▁  远山随会话生长  ▁▁▂▃▂▁▁▁▂▄▃▂▁▁▁▂▃▅▃▂▁▁▁▂▃▂▁▁▁  │
│ ● 霧 fog ✓1   │  ❯ 帮我调研并起草一份方案                      │
│ ⸽ 雨 rain     │                                                │
│ · 霜 frost    │  ✦ 织谱 · 3 梭          ← /task 多灵织造       │
│ · 雪 snow     │  ✓ ① 霧 调研竞品现状 (3.2s)                    │
│ · 露 dew      │  ⸽ ② 雨 起草方案 ←①     ← 执行中，符号脉冲     │
│ · 晴 fair     │  · ③ 霜 审校精炼 ←②                            │
│ ╌╌╌╌╌╌╌╌╌╌╌╌╌ │    ⸙ web_search 检索中…                        │
│ 山色有无中    │                                                │
│ 織 1/3 梭     │                                                │
├ ≋ 织造 1/3 ·· ──────────────────── gpt-4o · $0.02 · ▰▰▱▱▱ 41% ┤
│ ≋ ❯ █                                                          │
└─ /help 命令 · Tab 补全 · PgUp 回看 · Ctrl-C 退出 ──────────────┘
```

**技术要点**：流式文本不直接写终端，而是落入虚拟块缓冲区，每帧在内存中合成后差量重绘。流式与动效互不干扰。CJK 宽度计算贯穿所有排版路径。

### 经典线性模式

`sky --classic` 或管道 / 窄终端环境自动回退至线性对话流：

- 真实行编辑（←→ / Home·End / 退格 / 粘贴 / 中文均正确）
- `↑↓` 历史、`/` 命令 `Tab` 补全
- 回复**真流式**逐字呈现，按终端宽度智能换行（中英文 / 长链接不溢出）
- 每位灵以矿物色印章入场

### Web UI

```bash
sky web
# → http://localhost:3000
```

宣纸质感、六矿物颜料、按 Agent 切换的气象粒子与印章汉字。`⌘1-6` 唤灵切换。回复经 SSE **真流式**推送，工具调用呈现为「气象事件」。

---

## 命令与操作

### Slash 命令

| 类别 | 命令 | 说明 |
|------|------|------|
| **Agent 切换** | `/fog` `/rain` `/frost` `/snow` `/dew` `/fair` | 切换当前对话 Agent |
| **配置** | `/setup` `/apikey` `/model` | 安装向导、设置 Key、切换模型 |
| **信息** | `/status` `/cost` `/memory` `/workspace` `/version` | 查看系统状态 |
| **会话** | `/sessions` · `/resume <id>` · `/new` | 会话列表、恢复、新建 |
| **操作** | `/compact` `/retry` `/clear` `/task <goal>` | 压缩上下文、重试、编排 |
| **权限** | `/plan` `/auto` `/default` `/perm <模式>` | 计划/自动/默认；`/perm default\|auto\|accept\|strict\|bypass` 切权限模式 |
| **诊断** | `/context` `/tools` `/trace` `/agents` | Token 分布、工具统计、运行追踪、可派生子智能体清单 |
| **版本控制** | `/rewind [n]` | 文件检查点回退（不依赖 git） |
| **退出** | `/quit` `/exit` | 退出对话 |

### 输入宏

| 宏 | 说明 | 示例 |
|----|------|------|
| `@文件路径` | 将文件内容注入上下文 | `@src/main.ts 这个函数有bug` |
| `!shell命令` | Shell 输出入上下文（不耗 LLM） | `!git diff` |
| `#内容` | 一句话追加到 SKY.md 项目记忆 | `#项目用pnpm管理依赖` |

---

## 核心架构

### 智能路由与编排

Skyloom 的输入处理分三级，由规则引擎在 < 1ms 内完成分类（无需 LLM 调用）：

| 模式 | 触发条件 | 执行路径 |
|------|----------|----------|
| **direct** | 短问候、单句事实问答 | 直接回复，不调用工具 |
| **single** | 明确单步任务 | 单 Agent + 工具集 |
| **orchestrate** | 多步骤、含枚举/序号、长文本 | 雪（Snow）分解为 DAG → 多 Agent 协作 |

对于常见工作流（代码审查、调研后写作、重构后测试等），**9 种 Pipeline 模板**会在匹配后直接跳过 LLM 拆解，节省 2-3k tokens 的规划开销。

### 三层记忆

```
┌─────────────────────────────────────────────────┐
│  Short-term — SQLite 持久化会话上下文             │
│  Working  — 内存级任务作用域状态                   │
│  Long-term — 持久化 KV 存储 + 语义检索             │
└─────────────────────────────────────────────────┘
```

- **Short-term**：对话消息序列，SQLite 持久化，支持会话恢复与上下文压缩（`/compact`）
- **Working**：任务级临时状态（todo 清单、中间结果），存于内存，不怕上下文压缩丢失
- **Long-term**：持久化事实存储，支持 `remember_fact` / `recall_facts`，通过 TF-IDF + Cosine 语义检索召回

附加能力：
- **知识图谱**：实体-关系三重存储（SQLite），自动从对话中提取，支持 2-hop 传递查询
- **向量搜索**：TF-IDF + Cosine，CJK 感知分词，零外部依赖
- **持续学习**：任务完成后自动记录审查，失败模式入库用于去重与自进化

### 工具系统

| 工具类别 | 工具 | 说明 |
|----------|------|------|
| **文件操作** | `read_file` `write_file` `edit_file` `apply_patch` `delete_file` `copy_file` `move_file` | 文件读写编辑，支持 `offset/limit` 分页；`edit_file` 强制唯一匹配 + `replace_all` 返回统一 diff；`apply_patch` 原子化多文件 search/replace（全量校验后再落盘） |
| **搜索** | `list_directory` `tree` `file_search` `code_search` `grep` | 目录遍历、文件搜索、代码搜索 |
| **诊断** | `get_diagnostics` | LSP 式诊断：TS/JS 经工作区 TypeScript 编译器 API 取真实类型错误（行:列），其他语言走配置的 checker |
| **Shell** | `run_bash` `bash_output` `list_bash` `kill_bash` | 沙箱隔离执行，超时保护 + 输出限制；`background=true` 派后台长进程，增量读输出 / 列举 / 终止 |
| **子智能体** | `spawn_agent` | 派生隔离上下文的子智能体独立完成聚焦任务，只回传最终报告（对标 Claude Code Task 工具） |
| **网络** | `http_get` `http_post` `web_search` `fetch_page` | HTTP 请求 + 多引擎搜索（DDG/Bing/Baidu/Sogou 降级） |
| **Git** | `git_status` `git_diff` `git_log` `git_add` `git_commit` `git_checkout` | Git 操作 |
| **系统** | `system_info` `system_diagnose` `list_processes` `list_installed_apps` | 系统诊断 |
| **电脑操作** | `launch_app` `open_path` `kill_process` `install_software` 等 10 个 | 跨平台桌面操作 |
| **Agent 间** | `delegate_to` | 跨 Agent 任务委托 |
| **模型管理** | `set_my_model` | Agent 自主切换模型 |
| **记忆** | `remember_fact` `recall_facts` | 长期记忆读写 |
| **技能** | `use_skill` `list_skills` | 技能激活与管理 |
| **MCP** | `mcp_list_servers` `mcp_add_server` `mcp_remove_server` | MCP 服务器管理 |

工具框架特性：
- **重试与熔断**：每个工具支持 `maxRetries` + `retryDelay`，内置 Circuit Breaker 模式
- **结果缓存**：LRU 缓存（128 条目），可配置 `cacheable` 标记
- **超时保护**：默认 30s，可按工具配置
- **结果截断**：超大工具结果自动头尾保留 + 中间截断（默认 12k 字符），提示精确重取

### 子智能体（spawn_agent）

对标 Claude Code 的 `Task` 工具 / opencode subagents：任一灵都能用 `spawn_agent` 派生一个**隔离上下文**的子智能体，让它独立完成一段聚焦、自洽的工作，只把**最终报告**回传主上下文 —— 主对话不被中间步骤污染。

- **内置类型**：`general-purpose`（全工具，研究/多步执行）、`explore`（只读，广度搜索定位）
- **自定义**：在 `.sky/agents/<name>.md` 或 `.claude/agents/<name>.md` 放定义文件，frontmatter 兼容 Claude Code（`name` / `description` / `tools` / `model`），正文即系统提示；工具名自动映射（`Read`→`read_file` …）。`/agents` 查看全部
- **隔离与安全**：子智能体有独立的临时记忆（用完即删），可限定工具白名单，且**永不**持有 `spawn_agent`（无递归扇出）
- **扫描路径**：`~/.claude/agents` → `~/.skyloom/agents` → `.claude/agents` → `.sky/agents`（后者覆盖前者）

### 安全体系

Skyloom 的安全模型贯穿工具执行的全生命周期：

| 层级 | 机制 | 说明 |
|------|------|------|
| **危险分级** | 5 级 DangerLevel | `SAFE` → `LOW` → `MEDIUM` → `HIGH` → `CRITICAL`，每工具静态映射 |
| **红线拦截** | REDLINE_PATTERNS / REDLINE_COMMANDS | `rm -rf`、`format C:`、`sudo rm` 等永不自动批准 |
| **沙箱隔离** | `sandbox.ts` | 临时目录隔离、超时强制终止、输出大小限制（1MB）、执行前预检 |
| **SSRF 防护** | `assertFetchAllowed` | 阻止对私有/环回/链路本地地址的请求（DNS 解析后二次检查） |
| **工作区围栏** | `SKYLOOM_WORKSPACE_FENCE=1` | 可选：限制文件操作在项目根目录内 |
| **输出脱敏** | `filter.ts` | API Key / 密码 / 私钥 / 邮箱 / 内网 IP / 数据库连接串自动替换 |
| **审计日志** | 全链路 | 所有安全决策记录在案 |
| **Hooks** | `pre_tool` / `post_tool` | 用户自定义 shell 钩子，`pre_tool` 非零退出可拦截工具调用 |

### 技能系统

17 个内置技能，运行时按 Agent 职责动态激活：

| 技能 | 适用 Agent | 说明 |
|------|-----------|------|
| `web_research` | 雾 | 多引擎网络搜索与信息整合 |
| `code_analysis` | 雾 | 代码结构分析与理解 |
| `code_generator` | 雨 | 代码生成与实现 |
| `content_writer` | 雨 | 文档与内容创作 |
| `code_reviewer` | 霜 | 代码审查与质量评估 |
| `security_auditor` | 霜 | 安全漏洞审计 |
| `task_planner` | 雪 | 任务分解与计划制定 |
| `arch_designer` | 雪 | 系统架构设计 |
| `sys_operator` | 露 | 系统运维操作 |
| `ci_cd_manager` | 露 | CI/CD 流水线管理 |
| `emotional_companion` | 晴 | 情感陪伴与对话 |
| `self_evolve` | 晴 | 自我进化与 Prompt 优化 |
| `data_transformer` | 雨/霜 | 数据格式转换 |
| `document_analysis` | 雾 | 文档分析与提取 |
| `performance_checker` | 霜 | 性能分析与检查 |
| `api_integrator` | 雨 | API 集成与对接 |
| `workflow_designer` | 雪 | 工作流设计与编排 |

**Claude Code 技能迁移**：将 skill 文件夹放入 `.claude/skills/` 或 `.sky/skills/`，SKILL.md 同架构兼容（frontmatter `name/description/allowed-tools`，工具名自动映射），零拷贝迁移、改完即生效。

扫描路径：`~/.claude/skills` → `~/.skyloom/skills` → `.claude/skills` → `.sky/skills`

---

## 工程化能力

### 项目记忆 SKY.md

三层加载，自动注入所有 Agent 的系统提示：

1. `~/.skyloom/SKY.md` — 用户级（跨项目通用）
2. `./SKY.md` — 项目级（兼容 `CLAUDE.md` / `AGENTS.md`）
3. `./SKY.local.md` — 本地覆盖（不入版本控制）

`/init` 生成模板，`#内容` 快速追加。

### 验证闭环

任务写文件后自动运行配置的验证命令（测试 / lint / type-check），失败回灌 Agent 自动修复（默认 2 轮）：

```yaml
# ~/.skyloom/config.yaml
verify:
  commands: ["npm run -s type-check", "npm test -s"]
  max_fix_rounds: 2
```

也可在 SKY.md 的 `## Verify` 代码块中定义。`/verify` 手动触发。

### 计划模式

`Shift+Tab` 或 `/plan` 进入：只读工具集 + 先出编号方案，批准后切回执行。`/auto` 免审批模式。

### 文件检查点

`/rewind [n]` — 每轮自动快照被修改的文件，一键回退 n 轮。不依赖 git（`run_bash` 副作用除外）。

### 自定义命令

`.sky/commands/*.md`（项目级）/ `~/.skyloom/commands/`（用户级）：

- frontmatter 可指定 `description` / `agent`
- 正文支持 `$ARGUMENTS` `$1…$9` 占位符
- 子目录命名空间：`git/commit.md` → `/git:commit`
- 改完即生效

### Hooks

```yaml
hooks:
  session_start:
    - "echo session initialized"
  pre_tool:
    - matcher: "run_bash"
      command: "./scripts/guard.sh"   # 非零退出 = 拦截
  post_tool:
    - matcher: "write_file|edit_file"
      command: "npx prettier --write \"$SKY_FILE\""
```

环境变量：`SKY_TOOL`、`SKY_ARGS`、`SKY_FILE`、`SKY_AGENT`。

### 模型配置

`/model [id|unified <id>|reset|key <key>]` — 统一默认 + 每灵独立覆盖（模型与 API Key 均可），即改即生效并持久化。Agent 也能用 `set_my_model` 工具自己换模型。

### 自进化

失败模式分析 → Prompt diff 生成 → Agent 自主应用改进。经验库去重，7 天滑动窗口。

### 可观测性

| 命令 | 说明 |
|------|------|
| `/context` | 按角色分解 token 占用 + 系统提示 / 工具 / 技能开销 |
| `/tools` | 每工具调用次数 / 失败 / 缓存命中 / 平均耗时 / 熔断状态 |
| `/cost` | 累计用量与费用（按模型、按 Agent 细分） |

### MCP 双向桥

- **Client**：连接外部 MCP Server（stdio / SSE 传输），扩展工具集。兼容 `.mcp.json`（Claude Code 同款 schema）
- **Server**：`sky mcp` 启动，将 Skyloom Agent 暴露为工具供 Claude Desktop / Zed / Continue 等调用

---

## 支持的 LLM Provider

9 家 Provider，统一接口，支持自动 fallback 链与成本追踪：

| Provider | 可调模型 | 上下文窗口 |
|----------|----------|-----------|
| **OpenAI** | gpt-4.1, gpt-4.1-mini, gpt-4o, gpt-4o-mini, o4-mini | 128K – 1M |
| **Anthropic** | claude-sonnet-4-6, claude-opus-4-7, claude-haiku-4-5 | 200K |
| **DeepSeek** | deepseek-chat, deepseek-reasoner, deepseek-v4-flash, deepseek-v4-pro | 64K – 128K |
| **Google** | gemini-2.5-pro, gemini-2.5-flash | 1M |
| **Groq** | llama-4-scout, llama-3.3-70b, mixtral-8x7b | 32K – 128K |
| **OpenRouter** | gpt-4.1, claude-sonnet-4-6, gemini-2.5-flash, llama-4-maverick | 128K – 1M |
| **Mistral** | mistral-large, mistral-small | 32K – 128K |
| **xAI** | grok-4 | 128K |
| **Ollama** | llama3, qwen2.5, deepseek-r1（本地） | 8K – 32K |

模型目录是单一事实源，含上下文窗口与成本数据，参见 [`config/models.yaml`](config/models.yaml)。

---

## 项目结构

```
skyloom-ts/
├── src/
│   ├── cli/                  CLI 入口与交互层
│   │   ├── main.ts           命令注册 + 对话循环 (Commander)
│   │   ├── loom.ts           立轴全屏 TUI (差量重绘引擎)
│   │   ├── loom_chat.ts      立轴对话管理
│   │   ├── tui.ts            行编辑器 + 流式渲染 + CJK 宽度
│   │   ├── mode.ts           模式控制器
│   │   ├── input_macros.ts   @文件 !命令 #记忆 宏展开
│   │   └── commands_md.ts    自定义 .md 命令加载
│   ├── core/                 核心引擎 (44 模块)
│   │   ├── agent.ts          BaseAgent — LLM 推理循环 + 工具执行
│   │   ├── agent/
│   │   │   ├── task.ts       Task/TaskResult 领域模型
│   │   │   └── guard.ts      循环守卫（防无限工具调用）
│   │   ├── factory.ts        SystemContext — 统一启动 + 编排入口
│   │   ├── llm.ts            LLM 统一客户端（路由/重试/fallback/成本）
│   │   ├── memory.ts         三层记忆（SQLite + 内存 + 持久化 KV）
│   │   ├── bus.ts            异步事件总线（Agent 间通信）
│   │   ├── tool.ts           工具注册框架（重试/缓存/熔断/超时）
│   │   ├── tool_router.ts    工具智能选择（按上下文裁剪工具集）
│   │   ├── router.ts         复杂度路由（direct/single/orchestrate）
│   │   ├── pipelines.ts      9 种预定义 DAG 模板
│   │   ├── security.ts       5 级危险分级 + 红线拦截
│   │   ├── sandbox.ts        Shell 沙箱（隔离/超时/输出限制）
│   │   ├── filter.ts         输出脱敏（API Key/密码/PII）
│   │   ├── verify.ts         验证闭环（自动跑测试/lint）
│   │   ├── hooks.ts          生命周期钩子（pre/post_tool）
│   │   ├── checkpoint.ts     编排检查点（中断恢复）
│   │   ├── file_checkpoint.ts 文件快照（/rewind）
│   │   ├── skill.ts          技能注册与动态激活
│   │   ├── skymd.ts          SKY.md 三层加载
│   │   ├── mcp.ts            MCP Client（stdio/SSE 传输）
│   │   ├── mcp_server.ts     MCP Server（暴露 Agent 为工具）
│   │   ├── vector.ts         TF-IDF + Cosine 向量检索
│   │   ├── graph.ts          知识图谱（实体-关系三重存储）
│   │   ├── semantic.ts       字符 n-gram Jaccard 语义评分
│   │   ├── learn.ts          持续学习（任务审查 + 经验库）
│   │   ├── evolve.ts         自进化（失败分析 → Prompt 优化）
│   │   ├── longdoc.ts        长文档处理（滑动窗口 + 摘要链）
│   │   ├── circuit_breaker.ts 熔断器模式
│   │   ├── config.ts         配置管理（YAML 多层合并）
│   │   ├── catalog.ts        模型目录（单一事实源）
│   │   ├── estimate.ts       Token 估算
│   │   ├── arbitrate.ts      仲裁器
│   │   ├── cache.ts          LLM 缓存
│   │   ├── middleware.ts      中间件链
│   │   ├── profile.ts        性能分析
│   │   ├── theme.ts          Agent 主题（颜色/符号/诗句）
│   │   ├── icons.ts          Agent 图标
│   │   ├── workspace.ts      工作区管理
│   │   ├── schemas.ts        配置 Schema 校验
│   │   ├── model_config.ts   每灵模型配置
│   │   ├── constants.ts      全局常量
│   │   └── logger.ts         结构化日志
│   ├── agents/               6 个 Agent 定义
│   │   ├── fog.ts            雾 — 探索洞察
│   │   ├── rain.ts           雨 — 创造产出
│   │   ├── frost.ts          霜 — 精炼品质
│   │   ├── snow.ts           雪 — 架构规划
│   │   ├── dew.ts            露 — 可靠守护
│   │   └── fair.ts           晴 — 情感陪伴
│   ├── tools/                工具实现
│   │   ├── builtin.ts        内置工具（文件/搜索/网络/Git/Shell）
│   │   ├── computer.ts       电脑操作（10 个跨平台工具）
│   │   ├── delegate.ts       Agent 间委托
│   │   ├── model_tool.ts     模型自切换
│   │   └── todo.ts           任务清单工具
│   ├── skills/               技能加载器
│   │   └── loader.ts         SKILL.md 解析与注册
│   ├── plugins/              插件加载器
│   │   └── loader.ts         插件发现与注册
│   ├── web/                  Web 层
│   │   ├── server.ts         HTTP + SSE + 水墨气象台 UI
│   │   └── tts.ts            文本转语音
│   └── assets/               静态资源
├── config/
│   ├── default.yaml          默认配置
│   ├── providers.yaml        Provider 目录（base URL / env var）
│   ├── models.yaml           模型目录（上下文窗口 / 成本）
│   └── skills/               17 个内置技能 (SKILL.md)
├── tests/                    24 套件 · 240 Vitest 用例
├── docs/
│   ├── AESTHETIC_DESIGN.md   美学设计系统
│   └── OPTIMIZATION_PLAN.md  优化路线图
├── scripts/
│   ├── install.js            安装脚本
│   └── link.js               符号链接
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 开发

```bash
git clone https://github.com/susurrune/skyloom-ts.git
cd skyloom-ts
npm install

npm run build         # tsc 编译
npm run dev           # watch 模式
npm test              # Vitest (24 套件 · 240 用例)
npm run test:coverage # 覆盖率报告
npm run type-check    # TypeScript 严格模式检查
npm run lint          # ESLint
npm run format        # Prettier 格式化
```

### 技术栈

| 层面 | 选型 |
|------|------|
| 语言 | TypeScript 5.4 (strict mode) |
| 运行时 | Node.js ≥ 18 |
| 包管理 | npm |
| 测试 | Vitest 2.x + @vitest/coverage-v8 |
| 代码规范 | ESLint 9 + @typescript-eslint |
| 格式化 | Prettier 3.x |
| 数据库 | sql.js (SQLite, WASM) |
| HTTP | axios |
| CLI | commander |
| 终端渲染 | chalk + 自研差量重绘引擎 |
| 配置 | yaml |

### 路径别名

```json
"@skyloom/*": ["src/*"]
"@/*": ["src/*"]
```

---

## 路线图

Skyloom 正朝「顶级开源 Agent 框架」演进，对标 [opencode](https://github.com/sst/opencode) 的架构与 Claude Code 的交互范式。完整规划见 [优化计划](docs/OPTIMIZATION_PLAN.md)。

---

## 许可证

[MIT License](LICENSE) · **v1.14.7** · 全功能迁移自 [Python 原版](https://github.com/susurrune/skyloom)
