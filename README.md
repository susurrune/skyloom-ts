# 天空织机 · Skyloom

<div align="center">

**≋ 雾 · ⸽ 雨 · ✱ 霜 · ❉ 雪 · ∘ 露 · ☼ 晴**

*六位 Agent，一支团队 —— 一座水墨气象台。*

[![CI](https://github.com/susurrune/skyloom-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/susurrune/skyloom-ts/actions)
[![npm](https://img.shields.io/npm/v/skyloom?color=c0392b)](https://www.npmjs.com/package/skyloom)
[![License: MIT](https://img.shields.io/badge/license-MIT-3a7a6e.svg)](LICENSE)

</div>

---

**Skyloom** 是一个本地优先的多智能体终端框架。六个 Agent 各司其职，通过事件总线、三层记忆、DAG 编排引擎协作完成完整工作流。不是又一个 LLM 聊天客户端，而是一个**分工明确的 AI 团队**——而且，它好看。

每个 Agent 是一种天气、一味矿物颜料、一句古诗。这套贯穿 CLI、TUI 与 Web 的「水墨气象台」意象，是 Skyloom 的辨识度所在。设计理念见 **[美学设计系统](docs/AESTHETIC_DESIGN.md)**。

## 安装

```bash
npm install -g skyloom
sky
```

首次启动自动进入设置向导 — 选 provider → 输 API Key → 选模型，全部交互式完成。Key 保存在 `~/.skyloom/config.yaml`，更新不丢。随时 `/setup` 切换。

### 支持的 Provider（9 家）

| Provider | 可调模型 |
|----------|------|
| **DeepSeek** | deepseek-chat, deepseek-reasoner, deepseek-v4-flash, deepseek-v4-pro |
| **OpenAI** | gpt-4.1, gpt-4.1-mini, gpt-4o, gpt-4o-mini, o4-mini |
| **Anthropic** | claude-sonnet-4-6, claude-opus-4-7, claude-haiku-4-5 |
| **Google** | gemini-2.5-pro, gemini-2.5-flash |
| **Groq** | llama-4-scout, llama-3.3-70b, mixtral-8x7b |
| **OpenRouter** | gpt-4.1, claude-sonnet-4-6, gemini-2.5-flash, llama-4-maverick |
| **Mistral** | mistral-large, mistral-small |
| **xAI** | grok-4 |
| **Ollama** | llama3, qwen2.5, deepseek-r1（本地） |

> 模型目录是单一事实源，含上下文窗口与成本数据，参见 [`config/models.yaml`](config/models.yaml)。

## 命令

```bash
sky                  # 进入交互对话（全屏「立轴」水墨 TUI）
sky --classic        # 线性滚动界面（管道/窄终端会自动回退）
sky fog              # 直接和雾对话
sky task "写一个CLI"  # 多 Agent 编排
sky web              # Web UI → http://localhost:3000
sky apikey set <p>   # 保存 API Key
sky config           # 查看配置
sky mcp              # MCP Server
sky init             # 初始化
```

## 交互界面

### 立轴（默认 · 全屏水墨气象台）

`sky` 在真实终端中进入全屏**立轴**模式：顶部印章随当前灵换色，天幕一行气象粒子按灵的动势飘动（雾飘 · 雨落 · 霜结 · 雪降 · 露凝 · 晴升），远山剪影随会话渐渐生长；左栏常驻六灵，右侧正文真流式逐字「晕染」入场。差量重绘只刷新变化的行，流式与动效互不干扰。

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

多灵编排（`/task`）时整张挂轴活起来：**织谱**逐梭列出子任务与依赖、原位更新状态与耗时；左栏为每位灵亮起脉冲与 ✓/✗ 战绩；天幕上各灵的梭子拖着矿物色丝线来回穿行——一座看得见的织机。

### 经典线性（`--classic` / 管道环境）

线性对话流（如 Claude Code）—— 真实行编辑（←→ / Home·End / 退格 / 粘贴 / 中文均正确）、`↑↓` 历史、`/` 命令 `Tab` 补全。回复**真流式**逐字呈现，按终端宽度智能换行（中英文/长链接都不溢出）。每位灵以矿物色印章入场：

```
  ≋ 霧 ❯ 帮我写一个读取 CSV 的脚本

  ≋ 雾 fog
  好的。下面是一个最小实现，先看清需求再动手 ——

  ≋ web_search  "node csv parser"  …
  ✓ web_search

  这里用零依赖的方式读取并解析，按行流式处理避免一次性载入大文件……

  ≋ 霧 ❯ /            ← 输入 / 看命令面板，Tab 补全
```

## Slash 命令

| 类别 | 命令 |
|------|------|
| **Agent** | `/fog /rain /frost /snow /dew /fair` — 切换 |
| **配置** | `/setup /apikey /model` — 安装向导、设置 Key、模型 |
| **信息** | `/status /cost /memory /workspace /version` |
| **会话** | `/sessions` 列表 · `/resume <序号\|id>` 恢复 · `/new` 新会话 |
| **操作** | `/compact /retry /clear /task <goal>` |
| **退出** | `/quit /exit` |

## 六灵

| Agent | 矿物色 | 职责 | 技能 |
|-------|--------|------|------|
| ≋ **雾** Fog | 松烟墨 `#4a4a44` | 探索洞察 | web_research, code_analysis |
| ⸽ **雨** Rain | 石青 `#2a5c8a` | 创造产出 | code_generator, content_writer |
| ✱ **霜** Frost | 石绿 `#3a7a6e` | 精炼品质 | code_reviewer, security_auditor |
| ❉ **雪** Snow | 铅白 `#8a8a82` | 架构规划 | task_planner, arch_designer |
| ∘ **露** Dew | 赭石 `#8b6914` | 可靠守护 | sys_operator, ci_cd_manager |
| ☼ **晴** Fair | 朱砂 `#b3342d` | 情感陪伴 | emotional_companion, self_evolve |

## 工作流（Claude Code 级）

| 功能 | 用法 | 说明 |
|------|------|------|
| **项目记忆 SKY.md** | `/init` 生成 · `#内容` 快速追加 | 三层加载：`~/.skyloom/SKY.md`（用户级）→ `./SKY.md`（项目级，兼容 `CLAUDE.md`/`AGENTS.md`）→ `./SKY.local.md`，自动注入所有 agent 的系统提示 |
| **计划模式** | `Shift+Tab` 或 `/plan` | 只读工具集 + 先出编号方案，批准后切回执行；`/auto` 免审批模式 |
| **验证闭环** | config `verify.commands` 或 SKY.md `## Verify` 代码块 | 任务写文件后自动跑测试/lint，失败回灌自动修复（默认 2 轮）；`/verify` 手动触发 |
| **Headless** | `sky -p "问题" [--agent fog] [--json\|--stream-json]` | 管道/CI/外部编排接入；`cat err.log \| sky -p "归类错误"` |
| **输入宏** | `@文件` `!命令` `#记忆` | 文件注入上下文 / shell 输出入上下文（不耗 LLM）/ 一句话存进 SKY.md |
| **Hooks** | config `hooks.pre_tool/post_tool/session_start` | 强制执行的 shell 钩子，`pre_tool` 非零退出可拦截工具调用 |
| **上下文明细** | `/context` | 按角色分解 token 占用 + 系统提示/工具/技能开销 |
| **文件检查点** | `/rewind [n]` | 每轮自动快照被改文件，一键回退 n 轮（不依赖 git；`run_bash` 副作用除外） |
| **自定义命令** | `.sky/commands/*.md`（项目）/ `~/.skyloom/commands/`（用户） | frontmatter 可指定 `description`/`agent`，正文支持 `$ARGUMENTS` `$1…$9`，子目录命名空间 `git/commit.md` → `/git:commit`，改完即生效 |
| **模型配置** | `/model [id\|unified <id>\|reset\|key <key>]` | 统一默认 + 每灵独立覆盖（模型与 API key 均可），即改即生效并持久化；agent 也能用 `set_my_model` 工具**自己换自己的模型**（「换成 deepseek-chat」直接说就行） |
| **任务清单** | agent 自动调 `todo_write` | 3 步以上任务 agent 先列清单、逐项更新状态（✓ ◐ ·），存工作记忆不怕压缩，立轴/CLI 实时原位渲染 |
| **工具可观测** | `/tools` | 每工具调用次数/失败/缓存命中/平均耗时/熔断状态 |
| **上下文保护** | 自动 | 超大工具结果头尾保留中间截断（默认 12k 字符，`llm.tool_result_limit` 可调）并提示精确重取；`read_file` 支持 `offset/limit` 分页 |
| **Claude Code 技能迁移** | 把 skill 文件夹丢进 `.claude/skills/` 或 `.sky/skills/` | SKILL.md 同架构（frontmatter `name/description/allowed-tools`，`Bash/Read` 等工具名自动映射）；扫描 `~/.claude/skills` `~/.skyloom/skills` `.claude/skills` `.sky/skills`，**零拷贝迁移**、改完即生效 |
| **MCP 标准配置** | 项目根 `.mcp.json` | Claude Code 同款 schema（`mcpServers` + stdio/http + `${ENV_VAR}` 展开），与 config.yaml / `sky mcp` 添加的服务器合并（项目级优先） |

```yaml
# ~/.skyloom/config.yaml 示例
verify:
  commands: ["npm run -s type-check", "npm test -s"]
  max_fix_rounds: 2
hooks:
  post_tool:
    - matcher: "write_file|edit_file"
      command: "npx prettier --write \"$SKY_FILE\""
  pre_tool:
    - matcher: "run_bash"
      command: "./scripts/guard.sh"   # 非零退出 = 拦截
```

## 核心能力

| 模块 | 说明 |
|------|------|
| **真流式** | CLI 逐字渲染、Web SSE 推流；推理/正文/工具调用分层呈现 |
| **智能路由** | 输入自动分 direct/single/orchestrate 三级，< 1ms |
| **Pipeline 模板** | 9 种预定义工作流，命中后跳过 LLM 拆解 |
| **三层记忆** | Short-term(SQLite) + Working(内存) + Long-term(持久化) |
| **技能系统** | 17 个内置 SKILL.md，运行时动态激活 |
| **安全体系** | 5 级危险等级、红线拦截、沙箱隔离、审计日志 |
| **自进化** | 失败模式分析、Prompt 自动优化、经验库去重 |
| **向量搜索** | TF-IDF + Cosine，零依赖语义检索 |
| **知识图谱** | 实体-关系三重存储，自动从对话提取 |
| **输出过滤** | API Key/密码/私钥/邮箱/内网IP 自动脱敏 |
| **电脑操作** | 10 个跨平台工具（应用/诊断/进程/软件/服务） |
| **MCP** | 双向桥：Client 连接外部 + Server 暴露给 Claude Desktop |

## Web UI · 水墨气象台

```bash
sky web
# 打开 http://localhost:3000
```

宣纸质感、六矿物颜料、按 Agent 切换的气象粒子（雾飘/雨落/霜结/雪降/露凝/晴升）与印章汉字。`⌘1-6` 唤灵切换。回复经 SSE **真流式**推送，工具调用呈现为"气象事件"。

## 架构

```
src/
├── cli/        main.ts (命令注册+对话循环), tui.ts (行编辑+流式渲染), mode.ts
├── core/       agent, factory, llm, memory, tool, bus, security, learn,
│              evolve, sandbox, vector, graph, filter, estimate, arbitrate, ...
├── agents/     6 Agent (fog/rain/frost/snow/dew/fair)
├── tools/      builtin, computer, delegate
├── web/        server (水墨气象台 HTTP+UI), tts
├── skills/     技能加载器
├── plugins/    插件加载器
config/
├── skills/     17 个内置 SKILL.md
├── default.yaml  providers.yaml  models.yaml
tests/           16 套件 · 154 Vitest 用例
docs/            OPTIMIZATION_PLAN.md  AESTHETIC_DESIGN.md
```

## 开发

```bash
npm test          # vitest
npm run build     # tsc
npm run dev       # watch
npm run type-check
```

## 路线图

Skyloom 正朝「顶级开源 Agent 框架」演进，对标 [opencode](https://github.com/sst/opencode) 的架构与 Claude Code 的交互范式。完整规划见 **[优化计划](docs/OPTIMIZATION_PLAN.md)**：统一模型目录 → 真流式 → `agent.ts` 分层 → Session 与自动上下文压缩 → 工具/插件健壮性 → 测试门禁 → 美学工程化。

---

**[MIT License](LICENSE)** · **v1.13.6** · 全功能迁移自 [Python 原版](https://github.com/susurrune/skyloom)
