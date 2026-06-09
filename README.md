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
sky                  # 进入交互对话（线性流式 TUI）
sky fog              # 直接和雾对话
sky task "写一个CLI"  # 多 Agent 编排
sky web              # Web UI → http://localhost:3000
sky apikey set <p>   # 保存 API Key
sky config           # 查看配置
sky mcp              # MCP Server
sky init             # 初始化
```

## 交互界面

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
