# 天空织机 · Skyloom — 顶级 Agent 框架优化计划

> 目标：把 Skyloom 从「功能完整的多 Agent 终端」打磨成 **架构清晰、体验顶级、辨识度强** 的开源 Agent 框架。
> 参照系：[opencode](https://github.com/sst/opencode)（架构）、[Claude Code](https://docs.claude.com)（交互范式）、Skyloom Python 原版（功能对等）。
>
> 制定日期：2026-06-08 · 当前版本：v1.12.0 · 类型检查：✅ 通过

---

## 0. 现状诊断（Analysis）

### 0.1 项目规模

| 层 | 文件 | 关键模块 | LOC |
|----|------|----------|-----|
| CLI | `src/cli/` | main, tui, mode | ~700 |
| Core | `src/core/` | agent(1549), memory(1171), mcp(953), llm(804), factory(627) … 38 个模块 | ~11000 |
| Agents | `src/agents/` | fog/rain/frost/snow/dew/fair | ~500 |
| Tools | `src/tools/` | builtin, computer, delegate | ~700 |
| Web | `src/web/` | server(水墨气象台), tts | ~720 |
| Skills | `config/skills/` | 17 个 SKILL.md | — |
| Tests | `tests/` | 16 套件 · 154 用例（catalog/memory/task/agent_helpers/config） | — |

### 0.2 已经做得好的（保留 & 强化）

- **美学辨识度强**：水墨气象台 Web UI（宣纸纹理、六矿物色、粒子气象、印章汉字）——这是项目的灵魂，是优化的审美基线，不动它的方向，只做工程化与一致性提升。
- **功能广度大**：三层记忆、事件总线、DAG 编排、技能系统、向量检索、知识图谱、自进化、安全分级、MCP 双向桥、跨平台电脑操作。
- **路由分级**：direct / single / orchestrate 三级路由 + 9 种 Pipeline 模板，省 LLM 调用。

### 0.3 必须修复的问题（Critical）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| C1 | ~~虚构模型~~ **已更正**：`deepseek-v4-flash`/`v4-pro` 经 `/v1/models` 实测**是真实可调模型**（`deepseek-chat` 即其别名）。早先的"虚构"判断错误——会话初的报错来自 Claude Code **宿主**的子 agent 模型注册表，与 Skyloom 无关。已恢复入目录。 | — | — |
| C2 | **模型数据三处重复且漂移**：`config/models.yaml`、`cli/main.ts` 向导、`README` 表格各写一份 | 多处 | 维护噩梦、数据不一致（catalog 已统一✅） |
| C3 | **流式已实现却未接线**：`agent.chatStream()` 存在，但 CLI `chat()` 和 Web 都用阻塞式 `chat()` + 假打字机 | `cli/main.ts:314`、`web/server.ts:101` | 体验远低于 opencode/Claude Code；首字延迟高 |
| C4 | **README 模型表含虚构条目**（`deepseek-v4-*`）；测试数随增量需同步 | `README.md` | 可信度 |
| C5 | **`agent.ts` 1549 行巨石**：LLM 循环、工具执行、记忆、防循环启发式、委派全混在一个类 | `core/agent.ts` | 难测试、难维护 |

#### 🔴 集成测试发现并已修复的严重 Bug（用真实 DeepSeek key 验证）

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| **B1** | **首条消息必崩**：全新会话发第一条消息 → `Cannot read properties of undefined (reading 'content')`，且首轮请求**根本不含用户消息** | `Memory.addMessage` 把 push 放进**异步 mutex 回调**（fire-and-forget），而 `chatImpl`/`chatStreamImpl` 同一 tick 同步读 `getMessages()` → 读不到 | push 改为**同步**，仅保留改写数组的 prune 在锁内（[memory.ts](../src/core/memory.ts)）+ `messagesWithRecall` 防御性 guard + 回归测试 |
| **B2** | **用户选的模型被忽略**：`~/.skyloom/config.yaml` 设了 `default_model: deepseek-v4-flash`，却仍走 `gpt-4o`（无 key 必败） | `mergeConfigs` 丢弃了 `llm`/`default_model`/`default_provider` 等顶层键；且 `getModel` 读 camelCase `defaultModel` 而 YAML 是 snake_case `default_model` | `mergeConfigs` 保留全部顶层键并深合并 `llm`；`getModel` 按 `default_model → llm.default_model → …` 解析；`default.yaml` 移除每 Agent 硬编码 `gpt-4o`，统一由 `default_model` 驱动 |
| **B3** | **memory 配置 snake/camel 不匹配**（B2 修复后暴露）：Agent 构造崩在 `expandUserPath(undefined)` | `default.yaml` 用 `db_path`/`short_term_limit`，`Memory` 期望 `dbPath`/`shortTermLimit`；旧代码靠"配置被丢弃→走 fallback"侥幸不崩 | `BaseAgent` 构造时归一化 memory 配置，两种命名都接受 |
| **B4** | ~~`deepseek-v4-*` 虚构~~ **判断错误**：经 `/v1/models` 实测**真实可调**，且是用户日常默认模型 | 早先误判；会话初的报错来自 Claude Code **宿主**的子 agent 模型注册表 | 已恢复入目录 + 反转测试断言 |

> 这些 Bug 仅靠类型检查/单测无法发现——必须真实 API 集成验证。修复后 `fog.chat()` 返回「蓝色」、`chatStream` 实测 15–18 个 token 增量。

### 0.4 架构差距（对标 opencode）

| 维度 | opencode | Skyloom 现状 | 差距 |
|------|----------|-------------|------|
| Provider/Model | 强类型 Catalog（capabilities/cost/limit/status/variants） | 字符串前缀匹配（`isAnthropicModel`…） | **大** |
| Session | 持久化实体 + 事件日志 + 消息投影 | 内存对象，落 SQLite 但无事件溯源 | 中 |
| 上下文压缩 | 按 token 预算自动 compaction + checkpoint | 手动 `/compact` | 中 |
| 工具系统 | codec 校验输入输出 + 工具内 permission.assert | 注册表 + 全局 security 回调 | 中 |
| 插件 | 有序 hook 系统（init/provider.update…） | 目录加载器，无 hook 生命周期 | 中 |
| UI | client/server 分离，真流式 | TUI 仅捕获输入，响应回落到线性滚动 | 中 |

---

## 1. 优化原则

1. **不破坏美学**：水墨气象台是辨识度核心。所有 UI 改动只增强，不"极简化"。详见 [AESTHETIC_DESIGN.md](./AESTHETIC_DESIGN.md)。
2. **单一事实源**：每类数据（模型、命令、Agent 元数据、配色）只有一份定义。
3. **小步可验证**：每个增量保持 `tsc --noEmit` 绿 + 测试通过，再进下一步。
4. **功能对等优先于重构**：先保证不丢功能，再分层。
5. **类型安全**：消除无谓 `any`，用 schema 校验外部边界（LLM 响应、配置、工具 IO）。

---

## 2. 分阶段路线图

### Phase 0 — 止血（Critical Fixes）｜~0.5 天 ✅ 已完成

- [x] **P0.1 统一模型目录**（修 C2）
  新建 [`src/core/catalog.ts`](../src/core/catalog.ts)：单一类型化目录（`ModelInfo`/`ProviderMeta`），从 `config/models.yaml` 读取真实数据。修复了原 `config.ts:loadModelCatalog` 的字段名错配（`context`↔`context_window`）。设置向导现从 catalog 派生。
  ⚠️ 更正：曾误删 `deepseek-v4-flash/pro`，经 DeepSeek `/v1/models` 实测确认其真实可调后**已恢复**（见 C1）。
- [x] **P0.2 默认模型自检**：`chat()` 启动时用 `validateModel()` 校验当前模型，不在目录则给出可选清单与提示，而非静默 404。
- [x] **P0.3 README 校正**（修 C4）：真实模型表、移除虚构条目、链接到本计划与美学文档。
- [x] **测试**：新增 [`tests/catalog.test.ts`](../tests/catalog.test.ts) 11 用例（含"不含虚构模型"回归断言）。

**验收**：✅ 设置向导列出的每个模型都真实可调；`tsc --noEmit` 绿；9 套件 98 用例全通过。

### Phase 1 — Provider/Model Catalog 强化｜~1 天

对标 opencode `provider-model.md`：

- [ ] **P1.1** Catalog schema：`ModelInfo { id, providerID, family, capabilities{tools,input,output}, cost[], limit{context,output}, status }`。
- [ ] **P1.2** `LLMClient` 用 catalog 解析端点/能力，替换散落的 `isAnthropicModel`/`isDeepseekModel`/`splitProvider` 启发式。
- [ ] **P1.3** Provider 鉴权统一：env → `~/.skyloom/config.yaml` → 交互向导，三级回退集中到一处。
- [ ] **P1.4** 上下文窗口与成本从 catalog 取，喂给自动压缩（Phase 4）和成本统计。

### Phase 2 — 真流式接线（最高体验收益）｜~1 天 ✅ 基本完成

- [x] **P2.0 LLM 层真流式**（关键）：`streamWithTools` 原本只是包装阻塞 `complete()` 一次性吐出。新增 `callOpenAIStream` —— 对所有 OpenAI 兼容 provider 做真正的 SSE（`stream:true` + `stream_options.include_usage`），逐 token yield content/reasoning、按 index 累积 tool_calls、末帧取 usage 记成本。Anthropic 与流早期失败回落阻塞路径。**实测 DeepSeek 15–18 个增量**。
- [x] **P2.1 CLI 流式**：`chat()` 改为消费 `agent.chatStream()`（新 `streamResponse()`），逐字渲染真实 token，`reasoning` 淡墨斜体、正文矿物色、工具调用以天气符号脉冲呈现。删除旧的阻塞 `render()`。
- [x] **P2.2 Web 流式**：`/api/chat` 改 SSE（`text/event-stream`），前端 `fetch` + `ReadableStream` 真流式替换假打字机，工具调用呈现为"气象事件"系统消息。已 curl + 真实 API 验证。
- [x] **P2.3 中断**：`AbortSignal` 从 CLI 贯穿 `chatStream → streamWithTools → callOpenAIStream → fetch`。Ctrl-C 中断当前 turn 并**保留已产出内容**（轮间检测 abort → `interrupted` 事件 + 落库部分内容），二次 Ctrl-C 强退。实测 DeepSeek：abort 后 ~26ms 内停流（不再跑满整段生成）。

### Phase 3 — `agent.ts` 分层（可维护性）｜~1.5 天 🔵 进行中（1549 → 1396 行）

把巨石拆成职责单一的模块（保持对外 API 不变，re-export 兜底）：

- [x] `core/agent/task.ts` — 域模型 `Task`/`TaskState`/`TaskResult`/`AgentState`（纯、可测，re-export 验证身份一致）。
- [x] `agent_helpers.ts` += `parseExtractedFacts`（纯解析器，移出 BaseAgent）。
- [ ] `core/agent/loop.ts` — LLM 推理循环（`llmLoop` / `chatStreamImpl`，~275 行热路径）
- [ ] `core/agent/tools.ts` — 工具选择/执行/结果记录
- [x] `core/agent/guard.ts` — 防循环启发式抽成 `LoopGuard` 类（持有每轮状态，`observe()` 返回 hints/stop 决策，无副作用）。忠实迁移行为；agent 守卫终止测试仍通过。新增 [`tests/guard.test.ts`](../tests/guard.test.ts) 单测各分支（叙述循环/签名循环/失败堆积/搜索风暴）——这些此前**零覆盖**。期间发现并**修复**两处死安全网：all-failed 硬停（`>=8`）的 outcomes 缓冲上限 6→8；search-storm 硬停（`>=12`）改用**每轮累计搜索计数**（不再受 SIG_WINDOW=8 截断）。两个安全网现在如设计般触发，单测覆盖。
- [ ] `core/agent/delegate.ts` — 跨 Agent 委派与汇总
- [ ] `core/agent.ts` — 仅保留 `BaseAgent` 编排与公共 API（目标 < 500 行）

> ✅ **热路径测试网已就位**：[`tests/agent.test.ts`](../tests/agent.test.ts) 用**脚本化 mock LLM** 特征化了核心循环 —— 简单对话、阻塞 `chat()`、推理流、**工具调用回合**、**防循环 guard 终止**（模型重复同一工具 60 次仍能有界终止）。`loop/tools/guard/delegate` 的拆分现在可以安全进行（每步跑这套网 + 真实 API 抽查）。纯单元（task/helpers）已先抽出。

### Phase 4 — Session & 自动上下文管理｜~1.5 天

对标 opencode `session.md`：

- [x] **P4.1 Session 恢复 + 持久化修复**：新增 CLI `/sessions`（编号列表、标记当前）、`/resume <序号|id>`、`/new`。**并修复了一个严重 bug**：`persistDb()`（唯一写盘的代码）**从未被调用** → sql.js 纯内存 → 会话/长期记忆/工作记忆**重启全丢**（"启动自动恢复最新会话"形同虚设）。改为所有写经 `dbRun` 触发**防抖落盘** + `close()` 同步保存。新增跨实例持久化回归测试。
- [x] **P4.2 自动压缩（catalog 感知触发）**：`shouldAutoCompact()`/`contextUsage()` 不再硬编码 128K —— 改为按当前模型在 catalog 里的真实 `context` 窗口判断（留 20% 余量给回复）。修复了小窗口模型（deepseek-reasoner 64K、mixtral 32K）长聊时**先于压缩就溢出**的隐患；状态栏 % 与模型名也正确了。压缩本身（摘要 + 保留近 N 条 + 指令保真）已存在并已接线。后续：结构化 checkpoint + 溢出后重试（对标 opencode）。
- [ ] **P4.3 上下文快照**：环境信息、日期、工作区、激活技能合成一份"系统上下文"，模型可见但与历史分离（轻量版 Context Epoch）。

### Phase 5 — 工具与插件健壮性｜~1 天

- [x] **P5.1 工具输入校验 + 强制 coercion**（对标 opencode `tools.md`）：`ToolRegistry.validateAndCoerce` 在 `execute` 里于缓存/执行**之前**校验并归一化入参 —— 必填项缺失即拒、按声明类型 coerce（`"5"`→5、`"true"`→true、JSON 串→array/object）、enum 成员校验，handler 收到的是干净的类型化值，非法输入返回**可操作的**错误供模型重试。修了 `parseInt` 截断浮点(`"3.5"`→3)的隐患。见 [`tests/tool.test.ts`](../tests/tool.test.ts)（+7 用例）。输出校验暂未做。
- [x] **P5.2 权限模式内聚**（对标 Claude Code 权限模式）：把审批逻辑收敛为一个纯函数 `decideApproval(level, mode, tool) → allow/ask/deny`（[security.ts](../src/core/security.ts)），`checkApproval` 只做红线门禁 + 调用它 + 回调。新增模式 `acceptEdits`（自动放行文件编辑类工具,其余照 default 询问）与 `bypass`（除红线外全放行）;保留 `auto/interactive/strict` 行为不变。`/perm <default|auto|accept|strict|bypass>` 运行时切换(linear + loom),`config.cli.approvalMode` 启动时生效。新增 [`tests/security.test.ts`](../tests/security.test.ts) 11 用例覆盖决策矩阵。后续:让工具自身发起 `permission.assert`(细粒度 scope)。
- [ ] **P5.3 插件 hook**：目录加载器升级为有序 hook（`init` / `tool.register` / `provider.update`），插件在自己的 scope 注册，卸载即移除。

### Phase 6 — 测试与质量门禁｜~1.5 天

- [ ] **P6.1** 把覆盖率提到核心全覆盖：仍需 `llm`(mock)、`factory`、`pipelines`、`security` 套件（已建 `catalog`✅ `memory`✅ `task`✅ `agent_helpers`✅ `config`✅ `tui`✅ **`agent`✅(mock LLM)**，共 15 套件 142 用例）。`agent` 套件特征化了 chat/stream/工具回合/防循环 guard，为 `agent.ts` 拆分提供安全网。
- [ ] **P6.2** CI 加门禁：`type-check` + `lint` + `test` + 覆盖率阈值。
- [ ] **P6.3** 修正所有 `README`/文档与代码的数字一致性（测试数自动从 `vitest` 输出取）。

### Phase 7 — 美学工程化｜~1 天（详见 [AESTHETIC_DESIGN.md](./AESTHETIC_DESIGN.md)）

- [x] **P7.1 设计 token 单一源**：新建 [`src/core/theme.ts`](../src/core/theme.ts)（`PALETTE` + `AGENT_THEMES`：矿物色/汉字/天气符号/诗句/动势）。CLI 已接入；TUI/Web 待接（Web 仍内联 PIGMENTS，P7.3 抽取时统一）。
- [x] **P7.2 CLI 视觉升级（部分）**：欢迎横幅六灵各显矿物真彩 + 活动灵印章 `▣`；切灵时落朱印 + 诗句；流式正文矿物色、工具调用天气符号。"墨迹晕染"逐字过场待做。
- [ ] **P7.3 Web 抽出静态资源**：`server.ts` 内联 HTML 拆为 `web/ui/`（html/css/js），加构建步骤，便于演进与缓存。
- [ ] **P7.4 品牌资产**：SVG logo（印章风）、社交卡片、`docs/` 截图。

---

## 3. 里程碑与顺序

```
M1 止血+目录   Phase 0 + 1   → 真实可用、单一事实源
M2 体验飞跃     Phase 2 + 7.2 → 真流式 + CLI 视觉，最高感知收益
M3 工程地基     Phase 3 + 6   → 拆巨石 + 测试网，安全重构
M4 框架深度     Phase 4 + 5   → Session/压缩/工具/插件，对标 opencode
M5 打磨成品     Phase 7        → 美学工程化 + 品牌资产 + 发布
```

建议执行顺序：**M1 → M2 → M3 → M4 → M5**。M1/M2 立刻提升可信度与体验；M3 在动大手术前先织好测试网。

---

## 4. 成功标准（Definition of Done）

- 设置向导/文档中**每个模型都真实可调**，模型数据全局一份。
- CLI 与 Web **真流式**输出，首字延迟显著下降，可中断。
- `agent.ts` 拆分后**单文件 < 500 行**，核心模块均有单测，CI 绿且有覆盖率门禁。
- Session 可列举/恢复，超长上下文**自动压缩**不崩。
- 美学系统单一源驱动 CLI/TUI/Web，品牌资产齐备。
- README 与实现**零失真**。

---

## 5. 风险

| 风险 | 缓解 |
|------|------|
| 重构 `agent.ts` 引入回归 | Phase 6 测试网先行；逐块拆 + 每步跑测 |
| 流式与工具执行交错复杂 | 复用已存在的 `chatStreamImpl` 事件模型，只接线不重写 |
| Catalog 迁移漏模型 | 以 `config/models.yaml` 为真值源迁移，向导/README 派生 |
| 美学改动破坏现有观感 | 设计 token 抽取为"提取"非"重画"，先快照对比 |

---

## 6. Phase 8 — Claude Code / opencode 能力对齐 ✅ 已完成

四项核心能力补齐,全部 `tsc --noEmit` 绿 + 单测覆盖(351 → 387 用例,+36):

- [x] **P8.1 通用可定义子智能体**(对标 Claude Code `Task` 工具)
  [`src/core/subagent.ts`](../src/core/subagent.ts) + [`src/tools/spawn.ts`](../src/tools/spawn.ts):`spawn_agent` 工具派生**隔离上下文**的子智能体(独立临时记忆,用完即删),只回传最终报告。内置 `general-purpose` / `explore`;支持 `.sky/agents/*.md` 与 `.claude/agents/*.md` 自定义(frontmatter 兼容 Claude Code,工具名自动映射)。子智能体永不持有 `spawn_agent`(无递归)。`/agents` 列举。新增 [`tests/subagent.test.ts`](../tests/subagent.test.ts) 13 用例。
- [x] **P8.2 精确编辑 + diff**(对标 Claude Code `Edit`)
  [`src/core/diff.ts`](../src/core/diff.ts) + 升级 `edit_file`:强制**唯一匹配**(歧义即拒)、`replace_all`、no-op 检测、返回统一 diff(+/- 统计)。并修复旧实现 `String.replace` 把 `$&`/`$1` 当替换模式的隐患。新增 [`tests/edit_diff.test.ts`](../tests/edit_diff.test.ts) 10 用例。
- [x] **P8.3 后台任务 / 长进程**(对标 Claude Code Bash `run_in_background`)
  [`src/core/bgproc.ts`](../src/core/bgproc.ts):`run_bash` 加 `background=true` 派后台子进程,`bash_output`(增量读)/`list_bash`/`kill_bash` 控制。复用沙箱红线预检;滚动输出上限;会话退出 `killAll`(无孤儿)。新增 [`tests/bgproc.test.ts`](../tests/bgproc.test.ts) 5 用例。
- [x] **P8.4 诊断(LSP 关键能力)**(对标 opencode LSP)
  [`src/core/diagnostics.ts`](../src/core/diagnostics.ts) + `get_diagnostics` 工具:TS/JS 经**工作区** TypeScript 编译器 API 取真实语义诊断(行:列 + TS 码),零额外安装;其他语言走 `config.diagnostics` 配置的外部 checker(解析 `file:line:col` 输出)。新增 [`tests/diagnostics.test.ts`](../tests/diagnostics.test.ts) 8 用例。

> 这是把"完整的多 Agent 终端"推进到**与 Claude Code / opencode 同代能力面**的一步:可派生子智能体、精确可审计的编辑、后台进程、按文件诊断闭环。
