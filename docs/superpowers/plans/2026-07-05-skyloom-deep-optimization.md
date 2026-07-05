# Skyloom Deep Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Skyloom v1.26 从功能丰富的多 Agent 项目，收敛为边界清晰、运行可观测、会话可靠、扩展安全且三端体验一致的成品级 Agent 平台。

**Architecture:** 保持 TypeScript、CommonJS、零前端框架和六 Agent 产品模型。先建立跨入口共享的运行契约，再以特征测试保护现有行为，逐步拆分 `agent.ts`、`memory.ts`、`mcp.ts`、CLI 巨石；所有外部数据在边界处验证，所有运行状态由纯快照函数汇总。

**Tech Stack:** Node.js 18+、TypeScript strict、Vitest、SQL.js、Commander、原生 Node HTTP、Axios、YAML。

## Global Constraints

- 不引入 React、Vue 或其他前端框架。
- 不改变六 Agent 名称、职责和现有会话数据格式。
- 不新增运行时依赖，除非独立 ADR 证明现有依赖无法完成。
- 所有行为修改先写失败测试，再实现，再运行 `npm run type-check && npm run lint && npm test -- --run && npm run build`。
- 兼容 Windows、Linux、macOS；文件、进程和网络测试不得依赖真实外部服务。
- 单次任务保持可审查，不混入无关格式化和历史文件重写。

---

## Current Baseline

- 版本：`1.26.0`
- 源码：`src/` 约 103 个文件、32,000 行
- 自动测试：54 个测试文件、594 项测试
- 已有入口：CLI、全屏 TUI、Web、MCP Server、飞书/企业微信/QQ Gateway
- 当前主要结构风险：`agent.ts` 1810 行、`memory.ts` 1257 行、`mcp.ts` 1178 行、`loom.ts` 1219 行、`main.ts` 881 行

### Task 1: 统一运行健康与状态契约

**Files:**
- Create: `src/core/status.ts`
- Modify: `src/core/agent.ts`, `src/core/index.ts`, `src/web/server.ts`
- Test: `tests/status.test.ts`, `tests/web.test.ts`

**Interfaces:**
- Produces: `buildRuntimeStatus(context): RuntimeStatusSnapshot`
- Produces: `BaseAgent.getToolStats(): ToolRuntimeStat[]`
- Consumed by: Web `/api/status`、后续 CLI `/status`、诊断与发布 smoke test

- [x] 写失败测试，验证快照包含版本、运行时间、Agent 状态、工具调用/失败/缓存/熔断统计、后台任务、安全审计和 MCP 状态。
- [x] 运行 `npx vitest run tests/status.test.ts tests/web.test.ts`，确认因模块或字段缺失失败。
- [x] 实现纯状态聚合函数；禁止返回 API Key、请求正文、完整工具参数或用户消息。
- [x] Web `/api/status` 改为共享快照，不再内联拼装不完整对象。
- [x] 将工厂动态加载改为静态装配，并运行状态、Web、工厂定向回归测试。

### Task 2: CLI 与命令执行边界

**Files:**
- Create: `src/cli/runtime.ts`, `src/cli/command_handlers.ts`
- Modify: `src/cli/main.ts`, `src/cli/loom_chat.ts`, `src/core/commands.ts`
- Test: `tests/commands.test.ts`, `tests/loom.test.ts`, `tests/command_args.test.ts`

**Interfaces:**
- Produces: `executeSlashCommand(command, runtime): Promise<CommandOutcome>`
- Consumed by: classic CLI 与全屏 TUI

- [x] 用参数化测试锁定 `/status`、`/model`、`/sessions`、`/resume`、`/new`、`/verify` 的共享行为。
- [x] 抽取无终端绘制依赖的命令处理层，classic CLI 与全屏 TUI 只消费 `CommandOutcome`。
- [x] 删除 `main.ts` 与 `loom_chat.ts` 中重复的命令分支；`main.ts` 已降至 499 行。
- [x] 验证管道输入、非 TTY 回退和 Ctrl-C 行为，并用真实 CLI smoke 检查退出码。

已完成：共享 `/models` 等命令行为，删除 classic CLI 与全屏 TUI 的重复命令分支；抽离终端运行契约、经典渲染、配置/渠道向导和 headless/task 运行器。Agent 切换会同步失效或重载会话索引，避免跨 Agent 恢复错误；`main.ts` 从 881 行降至 499 行。

### Task 3: Agent 核心循环分层

**Files:**
- Create: `src/core/agent/loop.ts`, `src/core/agent/tools.ts`, `src/core/agent/delegation.ts`, `src/core/agent/session.ts`
- Modify: `src/core/agent.ts`
- Test: `tests/agent.test.ts`, `tests/guard.test.ts`, `tests/concurrency.test.ts`, `tests/trace.test.ts`

**Interfaces:**
- Produces: `AgentLoop`, `ToolCallExecutor`, `DelegationCoordinator`, `AgentSessionController`
- Preserves: `BaseAgent.chat()`, `chatStream()`, `executeTask()`, `getStatus()`

- [ ] 为流式工具回合、取消、中途持久化、并发 turn lock、重复工具防循环添加特征测试。
- [ ] 先移动纯工具执行代码，再移动委派，再移动流式循环；每次移动后运行 Agent 测试。
- [ ] `BaseAgent` 只保留生命周期、公共 API 和依赖组合，目标低于 700 行。
- [ ] 检查所有 span、工具消息和 partial response 的顺序与拆分前一致。

### Task 4: 多 Agent 编排与任务恢复

**Files:**
- Modify: `src/core/factory.ts`, `src/core/pipelines.ts`, `src/core/checkpoint.ts`, `src/core/arbitrate.ts`
- Test: `tests/pipelines.test.ts`, `tests/checkpoint_commands.test.ts`, `tests/task.test.ts`

**Interfaces:**
- Produces: `OrchestrationRun`，包含 DAG、步骤状态、依赖结果和恢复点

- [ ] 测试部分步骤失败、依赖跳过、同层并发、进程重启后恢复和重复任务 ID。
- [ ] 将执行状态从临时数组提升为可序列化运行对象。
- [ ] 失败重试只重跑失败节点及其下游，不重复已成功副作用任务。
- [ ] 汇总结果标明证据来源、失败节点和未执行节点。

### Task 5: LLM 与模型能力契约

**Files:**
- Modify: `src/core/llm.ts`, `src/core/catalog.ts`, `src/core/model_config.ts`, `config/models.yaml`
- Test: `tests/catalog.test.ts`, `tests/model_config.test.ts`, `tests/structured_retry.test.ts`

**Interfaces:**
- Produces: `ResolvedModel { provider, endpoint, capabilities, limits, pricing }`

- [ ] 测试 tools、vision、reasoning、streaming、context limit 和 fallback 能力解析。
- [ ] 用 catalog 替代 `llm.ts` 中散落的模型名前缀判断。
- [ ] 在发送请求前拒绝不支持的工具/图像组合并给出可执行提示。
- [ ] 统一错误分类为 auth、rate-limit、timeout、context-overflow、provider、cancelled。

### Task 6: 工具、权限与后台执行

**Files:**
- Modify: `src/core/tool.ts`, `src/core/security.ts`, `src/core/bgproc.ts`, `src/tools/guards.ts`, `src/tools/builtin.ts`
- Test: `tests/tool.test.ts`, `tests/security.test.ts`, `tests/bgproc.test.ts`, `tests/ssrf.test.ts`

**Interfaces:**
- Produces: `ToolExecutionContext` 中的 signal、attempt、agent、traceId、permission scope

- [ ] 为每个副作用工具声明 `read/write/process/network/system` scope。
- [ ] 权限判断按工具和目标资源执行，不再只按工具名粗粒度判断。
- [ ] 为同步 Shell 路径补充可终止子进程实现，确保超时不会留下继续运行的命令。
- [ ] 对后台任务增加显式清理命令、保留策略和退出确认状态。

### Task 7: 记忆、会话与上下文压缩

**Files:**
- Create: `src/core/memory/store.ts`, `src/core/memory/session.ts`, `src/core/memory/compaction.ts`
- Modify: `src/core/memory.ts`, `src/core/profile.ts`, `src/core/vector.ts`
- Test: `tests/memory.test.ts`, `tests/semantic.test.ts`, `tests/web.test.ts`

**Interfaces:**
- Produces: `MemoryStore`、`SessionRepository`、`CompactionPolicy`

- [ ] 测试 Agent 隔离、命名会话、并发写、损坏数据库恢复、删除活动会话和压缩后指令保真。
- [ ] 将 SQL 持久化、短期上下文和语义召回拆成三个边界。
- [ ] 所有数据库写返回完成 Promise，关闭时等待落盘。
- [ ] 压缩 checkpoint 保存被折叠消息范围、模型和摘要版本，允许审计和回滚。

### Task 8: Web API 与手绘界面成品化

**Files:**
- Create: `src/web/api.ts`, `src/web/contracts.ts`
- Modify: `src/web/server.ts`, `src/web/ui/app.ts`, `src/web/ui/styles.css`, `src/web/ui/index.html`
- Test: `tests/web.test.ts`, `tests/md_render.test.ts`, browser screenshot smoke tests

**Interfaces:**
- Produces: 版本化 JSON/SSE 合约和统一 `ApiError`

- [ ] 测试非法 Agent、失效 session、并发请求、SSE 中断、超大正文和静态资源缓存。
- [ ] 将路由、请求解析和静态资源服务从 `server.ts` 分开。
- [ ] Web 展示健康状态、当前 session 名、工具失败和可恢复错误，不暴露内部堆栈。
- [ ] 检查桌面、移动、深色、reduced-motion、键盘和屏幕阅读器行为。

### Task 9: 外部渠道网关可靠性

**Files:**
- Modify: `src/gateway/gateway.ts`, `src/gateway/types.ts`, `src/gateway/channels/*.ts`, `src/gateway/helpers.ts`
- Test: `tests/gateway.test.ts`, `tests/channel_setup.test.ts`

**Interfaces:**
- Produces: `InboundEnvelope`、`DeliveryResult`、渠道无关的幂等键

- [ ] 测试重复 Webhook、乱序消息、签名失败、媒体超限、回复失败和渠道超时。
- [ ] 按渠道消息 ID 去重，避免平台重试触发两次 Agent 回复。
- [ ] 将接收成功与异步处理结果分开，渠道超时不丢任务。
- [ ] 日志统一带 channel、conversation、message 和 trace 标识。

### Task 10: Skills、Plugins 与 MCP 生命周期

**Files:**
- Modify: `src/core/skill.ts`, `src/skills/loader.ts`, `src/plugins/loader.ts`, `src/core/mcp.ts`
- Test: `tests/skill.test.ts`, `tests/plugins.test.ts`, `tests/mcp_sse.test.ts`

**Interfaces:**
- Produces: `ExtensionDescriptor` 和统一的 load/activate/health/deactivate 状态

- [ ] 测试重复名称、坏 frontmatter、插件部分加载失败、MCP 重连和工具冲突。
- [ ] 加载器返回结构化诊断，不再只记日志后静默跳过。
- [ ] MCP 连接增加指数退避、最大重连次数和健康状态快照。
- [ ] 卸载扩展时清理工具、hook、进程和缓存。

### Task 11: 安全、观测与故障诊断

**Files:**
- Modify: `src/core/security.ts`, `src/core/trace.ts`, `src/core/logger.ts`, `src/core/diagnostics.ts`
- Test: `tests/security.test.ts`, `tests/trace.test.ts`, `tests/logger.test.ts`, `tests/diagnostics.test.ts`

**Interfaces:**
- Produces: `RuntimeStatusSnapshot`、结构化错误码、可导出的诊断包

- [ ] 对日志中的 token、authorization、cookie、API key 和常见密钥格式做统一脱敏。
- [ ] trace 关联 LLM、工具、委派、渠道和会话 ID。
- [ ] 增加 `sky doctor --json`，检查配置、工作区、数据库、模型凭据存在性、MCP 和端口。
- [ ] 诊断包默认不包含用户消息和文件正文。

### Task 12: 配置、文档、CI 与发布质量

**Files:**
- Modify: `src/core/config.ts`, `.github/workflows/ci.yml`, `README.md`, `docs/OPTIMIZATION_PLAN.md`, `package.json`
- Create: `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`
- Test: `tests/config.test.ts`, packaging smoke test

**Interfaces:**
- Produces: 可版本迁移的配置 schema 和可安装 npm 包

- [ ] 测试旧配置迁移、未知字段、错误 YAML、环境变量覆盖和安装后资源路径。
- [x] CI 增加覆盖率报告、构建产物 smoke、Windows runner 和依赖审计。
- [ ] README 的版本、测试数、模型表和截图由脚本或稳定来源生成。
- [ ] 发布前从 npm tarball 安装并运行 `sky version`、`sky web`、`sky mcp` smoke。

## Execution Order

1. Task 1、11：先建立可观测契约，后续优化能被量化。
2. Task 2、3：拆 CLI 与 Agent 巨石，降低后续修改风险。
3. Task 6、7：强化工具副作用和会话数据可靠性。
4. Task 4、5：提升编排与模型能力判断。
5. Task 8、9、10：完善 Web、渠道和扩展生态。
6. Task 12：完成文档、CI、安装包和发布闭环。

## Definition of Done

- 公开入口共享同一运行状态、命令、模型和会话契约。
- `agent.ts < 700` 行、`main.ts < 500` 行，巨石模块均有职责明确的子模块。
- 用户中断在 100 ms 内停止支持取消的 LLM、网络与进程任务。
- 任一 Agent 的会话、缓存和工具统计不会泄漏到其他 Agent。
- Web、CLI、TUI 和渠道对同一错误给出一致且可恢复的结果。
- 全量 type-check、lint、测试、构建、Windows/Linux CI 和安装包 smoke 通过。
