# Skyloom Python → TypeScript 完整转换计划

## 已完成的核心模块（✅）

### 基础配置层
- ✅ `constants.ts` - 所有常量定义（VALID_AGENTS, TASK_DONE_SENTINEL, etc）
- ✅ `schemas.ts` - LLM 响应验证和数据结构（TaskPlanSchema, FactSchema）
- ✅ `logger.ts` - 结构化日志系统（JSON lines format）
- ✅ `config.ts` - 配置管理（YAML加载、合并、提供者目录）

### 工具和中间件层
- ✅ `tool.ts` - 工具注册和执行框架（缓存、重试、参数验证）
- ✅ `circuit_breaker.ts` - 熔断器模式（故障容错）

## 待转换的模块

### Phase 1: 核心基础设施（Core Infrastructure）
- [ ] `memory.ts` - 三层内存系统（短期、工作、长期）+ SQLite 持久化
- [ ] `cache.ts` - LLM 响应缓存
- [ ] `middleware.ts` - 中间件链（前处理、后处理）
- [ ] `bus.ts` - 事件总线系统
- [ ] `pipelines.ts` - DAG 管道编排

### Phase 2: LLM 和 API 集成
- [ ] `llm.ts` - LiteLLM 抽象（流式、重试、成本追踪）
- [ ] `mcp.ts` - 模型上下文协议集成
- [ ] `semantic.ts` - 语义搜索和嵌入

### Phase 3: Agent 核心
- [ ] `agent.ts` - BaseAgent 类（message management, tool execution）
- [ ] `factory.ts` - Agent 工厂模式
- [ ] `router.ts` - 智能路由系统（direct/single/orchestrate 分类）

### Phase 4: 六个 Agent 实现
- [ ] `agents/fog.ts` - 研究 Agent
- [ ] `agents/rain.ts` - 代码生成 Agent
- [ ] `agents/frost.ts` - 代码审查 Agent
- [ ] `agents/snow.ts` - 编排 Agent
- [ ] `agents/dew.ts` - DevOps Agent
- [ ] `agents/fair.ts` - 情感陪伴 Agent

### Phase 5: 技能系统
- [ ] `skill.ts` - 技能基类和注册表
- [ ] `skills/loader.ts` - 技能动态加载
- [ ] 40+ 内置技能转换

### Phase 6: 工具系统
- [ ] `tools/builtin.ts` - 内置工具（文件、shell、HTTP、git）
- [ ] `tools/delegate.ts` - MCP 工具委派

### Phase 7: CLI 和 Web
- [ ] `cli/main.ts` - 命令行入口（Commander.js）
- [ ] `cli/mode.ts` - 交互模式管理
- [ ] CLI 子命令（chat, task, web, setup）
- [ ] `web/server.ts` - Express/Fastify 服务器
- [ ] `web/tts.ts` - 文字转语音集成

### Phase 8: 测试
- [ ] 所有 52 个测试文件转换为 Vitest

## 转换规范

### 文件映射

| Python | TypeScript | 备注 |
|--------|-----------|-----|
| `asyncio` | `Promise / async-await` | 原生支持 |
| `dataclasses` | `interfaces + types` | TypeScript types |
| `pathlib.Path` | `path` module | Node.js 标准 |
| `aiosqlite` | `sqlite / sqlite3` | Node.js SQLite |
| `typer` | `commander` | CLI 框架 |
| `rich` | `chalk` + `enquirer` | TUI 输出 |
| `pyyaml` | `yaml` npm package | YAML 处理 |
| `litellm` | `openai` + providers | LLM SDK |
| `httpx` | `axios` / `got` | HTTP 客户端 |
| `pytest` | `vitest` | 测试框架 |

### 关键转换模式

#### 1. Python Dataclass → TypeScript Interface + Class
```python
@dataclass
class Message:
    role: str
    content: str
```

```typescript
interface Message {
  role: string;
  content: string;
}
```

#### 2. Python Dict/List 操作 → TypeScript Map/Set/Array
```python
data: dict[str, list[str]] = {}
```

```typescript
data: Map<string, string[]> = new Map();
```

#### 3. Python 异步 → TypeScript Async/Await
```python
async def fetch():
    result = await client.get()
```

```typescript
async function fetch() {
  const result = await client.get();
}
```

#### 4. Python 类型提示 → TypeScript 类型注解
```python
def execute(tool: str, params: dict) -> str:
```

```typescript
function execute(tool: string, params: Record<string, unknown>): string
```

## 命名规范（保持一致）

- Agent 名称：`fog`, `rain`, `frost`, `snow`, `dew`, `fair`（全部小写）
- 文件名：camelCase（`agentFactory.ts` 而非 `agent_factory.ts`）
- 变量名：camelCase（`maxRetries` 而非 `max_retries`）
- 常量：UPPER_SNAKE_CASE（`DEFAULT_TOOL_TIMEOUT`）
- 接口：PascalCase（`ToolRegistry`, `Message`, `AgentConfig`）

## 依赖管理

### 核心依赖映射
| 功能 | Python | TypeScript |
|------|--------|-----------|
| CLI | typer | commander |
| TUI | rich | chalk + enquirer + ora |
| LLM | litellm | openai + axios |
| Database | aiosqlite | sqlite / better-sqlite3 |
| YAML | pyyaml | yaml |
| HTTP | httpx | axios / got |
| 测试 | pytest | vitest |
| 类型检查 | mypy | typescript |

### 质量保证工具
- **Linter**: eslint + @typescript-eslint
- **格式化**: prettier
- **类型**: TypeScript strict mode
- **测试**: vitest + coverage

## 大小估计

| 层级 | 文件数 | LOC | 转换难度 |
|-----|--------|-----|---------|
| Core | 8 | 2500 | ⭐⭐ |
| Memory | 1 | 800 | ⭐⭐⭐ |
| Agents | 7 | 2000 | ⭐⭐ |
| Skills | 40+ | 8000 | ⭐ |
| Tools | 2 | 2000 | ⭐⭐ |
| CLI/Web | 10 | 3000 | ⭐⭐⭐ |
| Tests | 52 | 10000 | ⭐⭐ |
| **总计** | **120+** | **28000** | - |

## 质量检查清单

- [ ] 所有 TypeScript 文件通过 tsc --noEmit
- [ ] 所有文件通过 eslint
- [ ] 100% 类型覆盖率（no `any` 除非必要）
- [ ] 所有测试通过（npm test）
- [ ] CLI 命令可执行（npm start）
- [ ] Web 服务启动正常
- [ ] 配置加载和合并正确
- [ ] 内存系统持久化正确
- [ ] Agent 通信链正常
- [ ] 工具执行链正常

## 转换步骤

1. ✅ 基础配置（constants, schemas, logger, config）
2. ✅ 工具框架（tool, circuit_breaker）
3. ⏳ 转换其他核心模块（使用 agent 并行）
4. ⏳ 转换 Agent 系统
5. ⏳ 转换 CLI/Web 接口
6. ⏳ 转换所有测试
7. ⏳ 集成测试和优化

---

**目标**: 完整的功能对等、无任何功能丢失、所有业务逻辑保持一致的 TypeScript 版本。
