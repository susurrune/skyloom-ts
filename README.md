# 天空织机 · Skyloom

**6 个天气主题 AI Agent** — 雾·雨·霜·雪·露·晴

## 一键安装

```bash
# 方式一：项目内安装（自动全局注册）
git clone https://github.com/susurrune/skyloom-ts.git
cd skyloom-ts
npm run setup               # ← 一条命令：安装 → 编译 → 注册全局 sky 命令

# 方式二：全局安装（像 Claude Code 一样）
npm install -g skyloom       # 发布后
# 或本地：
npm install -g ./             # 装完后终端输入 sky 即可使用

# 方式三：直接运行（免安装）
npx skyloom
```

装完后在任意终端输入 `sky` 就能用。

## 命令

| 命令 | 用途 |
|------|------|
| `sky chat` | 交互式对话（默认雾） |
| `sky chat fog` | 指定 Agent 对话 |
| `sky web` | 启动水墨气象台 Web UI → http://localhost:3000 |
| `sky task "写一个 CLI 工具"` | 多 Agent 编排协作 |
| `sky config` | 查看配置 |
| `sky mcp` | MCP Server（Claude Desktop 可连接） |
| `sky init` | 初始化配置 |

## 六灵 · Agents

|  | 名称 | 矿物色 | 职责 |
|--|------|--------|------|
| ≋ | **雾** Fog | 松烟墨 | 探索洞察 · 研究 |
| ⸽ | **雨** Rain | 石青 | 创造产出 · 代码 |
| ✱ | **霜** Frost | 石绿 | 精炼品质 · 审查 |
| ❉ | **雪** Snow | 铅白 | 架构规划 · 编排 |
| ∘ | **露** Dew | 赭石 | 可靠守护 · 运维 |
| ☼ | **晴** Fair | 朱砂 | 情感陪伴 · 温暖 |

## 开发

```bash
npm test          # 87 测试
npm run build     # 编译
npm run dev       # watch 模式
npm install -g ./ # 本地全局安装
```

## 架构

```
src/
├── core/         核心框架（agent, llm, memory, tool, bus...）
├── agents/       6 个 Agent 实现
├── tools/        内置工具（文件、Shell、HTTP、Git、系统操作）
├── cli/          命令行界面
├── web/          Web 服务器 + 水墨 UI
├── skills/       技能加载器
└── plugins/      插件加载器
```
