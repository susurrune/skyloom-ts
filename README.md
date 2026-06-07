# 水墨气象台 · Skyloom

**6 个天气主题 AI Agent** — 雾雨霜雪露晴

## 一键安装

```bash
# 1. 克隆
git clone https://github.com/susurrune/skyloom-ts.git
cd skyloom-ts

# 2. 自动安装 + 编译 + 全局链接
npm run setup
```

完成后 `sky` 命令全局可用。

## 命令

| 命令 | 用途 |
|------|------|
| `sky chat` | 交互式聊天（默认 fog） |
| `sky chat fog` | 切换到指定 Agent |
| `sky web` | 启动 Web UI → http://localhost:3000 |
| `sky task "写一个CLI工具"` | 多 Agent 编排 |
| `sky config` | 查看配置 |
| `sky mcp` | MCP Server（Claude Desktop 可连接） |

## Agent

| 名称 | 矿物色 | 职责 |
|------|--------|------|
| ≋ 雾 Fog | 松烟墨 | 探索洞察 |
| ⸽ 雨 Rain | 石青 | 创造产出 |
| ✱ 霜 Frost | 石绿 | 精炼品质 |
| ❉ 雪 Snow | 铅白 | 架构规划 |
| ∘ 露 Dew | 赭石 | 可靠守护 |
| ☼ 晴 Fair | 朱砂 | 情感陪伴 |

## 开发

```bash
npm test          # 87 tests
npm run build     # 编译
npm run dev       # watch 模式
```
