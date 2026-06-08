# 天空织机 · Skyloom

<div align="center">

**≋ 雾 · ⸽ 雨 · ✱ 霜 · ❉ 雪 · ∘ 露 · ☼ 晴**

*六位 Agent，一支团队。*

[![CI](https://github.com/susurrune/skyloom-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/susurrune/skyloom-ts/actions)
[![npm](https://img.shields.io/npm/v/skyloom?color=cyan)](https://www.npmjs.com/package/skyloom)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

</div>

---

**Skyloom** 是一个本地优先的多智能体终端框架。六个 Agent 各司其职，通过事件总线、三层记忆、DAG 编排引擎协作完成完整工作流。不是又一个 LLM 聊天客户端，而是一个**分工明确的 AI 团队**。

## 安装

```bash
npm install -g skyloom
sky
```

首次启动自动进入设置向导 — 选 provider → 输 API Key → 选模型，全部交互式完成。

### 支持的 Provider（9 家，30+ 模型）

| Provider | 模型 |
|----------|------|
| **DeepSeek** | chat, v4-flash, v4-pro, reasoner |
| **OpenAI** | gpt-4.1, gpt-4o, gpt-4o-mini, o4-mini |
| **Anthropic** | claude-sonnet-4-6, claude-opus-4-7, claude-haiku-4-5 |
| **Google** | gemini-2.5-pro, gemini-2.5-flash |
| **Groq** | llama-3.3-70b, mixtral-8x7b |
| **OpenRouter** | gpt-4.1, claude-sonnet-4-6, gemini-2.5-flash 等 |
| **Mistral** | mistral-large, mistral-small |
| **xAI** | grok-4 |
| **Ollama** | llama3, qwen2.5, deepseek-r1 (本地) |

Key 保存在 `~/.skyloom/config.yaml`，更新不丢。随时 `/setup` 切换。

## 命令

```bash
sky                  # 全屏 TUI 交互对话
sky fog              # 直接和雾对话
sky task "写一个CLI"  # 多 Agent 编排
sky web              # Web UI → http://localhost:3000
sky apikey set <p>   # 保存 API Key
sky config           # 查看配置
sky mcp              # MCP Server
sky init             # 初始化
```

## TUI

输入 `/` 弹出命令面板，↑↓ 选择，字母过滤，Enter 确认：

```
┌── 天空织机 v1.12 ──────────────────┐
├──────────┬─────────────────────────┤
│ ≋ 雾 Fog│                         │
│ ⸽ 雨 ▸  │  用户消息                │
│ ✱ 霜    │                         │
│ ❉ 雪    │  助手回复                │
│ ∘ 露    │                         │
│ ☼ 晴    │                         │
├──────────┴─────────────────────────┤
│ ┌── commands ────────────────────┐ │
│ ▶ ≋ /fog    雾 Fog · 松烟墨      │ │
│     /setup  配置向导              │ │
│     /cost   费用统计              │ │
│ └────────────────────────────────┘ │
│ > /                                 │
└─────────────────────────────────────┘
```

## Slash 命令

| 类别 | 命令 |
|------|------|
| **Agent** | `/fog /rain /frost /snow /dew /fair` — 切换 |
| **配置** | `/setup /apikey /model` — 安装向导、设置Key、模型 |
| **信息** | `/status /cost /memory /sessions /workspace /version` |
| **操作** | `/compact /retry /clear /task <goal>` |
| **退出** | `/quit /exit` |

## 六灵

| Agent | 矿物色 | 职责 | 技能 |
|-------|--------|------|------|
| ≋ **雾** Fog | 松烟墨 | 探索洞察 | web_research, code_analysis |
| ⸽ **雨** Rain | 石青 | 创造产出 | code_generator, content_writer |
| ✱ **霜** Frost | 石绿 | 精炼品质 | code_reviewer, security_auditor |
| ❉ **雪** Snow | 铅白 | 架构规划 | task_planner, arch_designer |
| ∘ **露** Dew | 赭石 | 可靠守护 | sys_operator, ci_cd_manager |
| ☼ **晴** Fair | 朱砂 | 情感陪伴 | emotional_companion, self_evolve |

## 核心能力

| 模块 | 说明 |
|------|------|
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

## Web UI

```bash
sky web
# 打开 http://localhost:3000
# 水墨气象台 — 宣纸质感、矿物颜料、笔触纹理
```

## 架构

```
src/
├── cli/        main.ts (命令注册+TUI循环), tui.ts (全屏渲染+弹窗), mode.ts
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
tests/           87 个 Vitest 测试
```

## 开发

```bash
npm test          # 87 tests
npm run build     # tsc
npm run dev       # watch
```

**[MIT License](LICENSE)** · **v1.12.0** · 全功能迁移自 [Python 原版](https://github.com/susurrune/skyloom)
