# Maintainer Architecture Guide

更新时间：2026-03-06

本文面向维护者，目标是回答三件事：

1. 功能应放在哪一层。
2. 异常时先查哪条链路。
3. 哪些契约不能破坏。

## 1. 分层地图

| 层 | 代表模块 | 主要职责 | 不负责 |
| --- | --- | --- | --- |
| CLI 入口层 | `src/index.js` | 命令分发、参数入口、对外帮助 | 业务细节与检索策略 |
| Agent 会话层 | `src/agent.js` | 模型调用、工具循环、上下文拼装 | 索引内部实现 |
| 工具总线层 | `src/tools.js` + `src/tool-*.js` | 工具定义、执行路由、安全约束 | CLI 交互体验 |
| 索引实现层 | `src/code-index.js` / `src/syntax-index.js` / `src/semantic-graph.js` / `src/vector-index.js` | 构建、刷新、查询单一索引源 | 多路融合编排 |
| 检索编排层 | `src/retrieval-*` / `src/hybrid-*` | 多源召回、融合排序、降级、解释协议 | MCP 传输与协议暴露 |
| 增量刷新层 | `src/index-watch-*` | 变化发现、队列、反压、刷新触发、watch 指标 | 查询排序 |
| MCP 暴露层 | `src/mcp-*` | MCP RPC/transport、toolset policy、facade 封装 | 重写检索逻辑 |

## 2. 三个高频模块簇

### 2.1 `hybrid-*` / `retrieval-*`

职责：多源检索编排、排序、解释、回放评测。

关键文件：

- `src/retrieval-orchestrator.js`
- `src/hybrid-query-pipeline.js`
- `src/hybrid-ranking.js`
- `src/hybrid-rerank.js`
- `src/retrieval-result-protocol.js`
- `src/hybrid-replay.js`

排查顺序：

1. orchestrator 是否拿到各来源结果。
2. ranking/rerank 是否造成排序异常。
3. result protocol 是否完整写出解释字段。
4. replay 与 metrics 是否能复现。

### 2.2 `mcp-*`

职责：把内部能力受控暴露为 MCP 工具。

关键文件：

- `src/mcp-server.js`
- `src/mcp-server-rpc.js`
- `src/mcp-tool-definitions.js`
- `src/mcp-tool-dispatch.js`
- `src/mcp-toolset-policy.js`
- `src/mcp-transport-runners.js`

排查顺序：

1. options/runtime 是否解析正确。
2. toolset policy 是否拦截。
3. dispatch/runtime 是否正确路由到 facade。
4. facade 下游工具本身是否失败。

### 2.3 `index-watch-*`

职责：增量索引新鲜度与 watch 运行稳定性。

关键文件：

- `src/index-watch-config.js`
- `src/index-watch-path-policy.js`
- `src/index-watch-queue.js`
- `src/index-watch-loop.js`
- `src/index-watch-refresh.js`
- `src/index-watch-flush.js`
- `src/index-watch-metrics.js`

排查顺序：

1. path policy 是否过滤错。
2. snapshot/hash 是否误判无变化。
3. queue/flush 是否被 debounce/backpressure 延迟。
4. refresh 子链路是否失败。
5. metrics 是否记录了 lag、retry、slow flush。

## 3. 改动放置规则

- 新命令或入口：优先改 `src/index.js`（或对应 CLI 入口文件）。
- 多路检索策略：优先改 `src/hybrid-*` / `src/retrieval-*`。
- 单索引构建与查询：改对应 index 模块。
- 代码变化到刷新链路：改 `src/index-watch-*`。
- 对外 MCP 能力与权限：改 `src/mcp-*`。

## 4. 明确禁止

- 不在 `mcp-server.js` 堆积业务分支。
- 不在 CLI 层拼装复杂检索策略。
- 不在 watch 层实现查询排序。
- 不让单一 index 模块承担多源融合职责。

## 5. 默认非回归检查

```bash
npm run lint
npm run contract:check
npm run typecheck
npm test
```

若影响检索质量或 watch 行为，再补：

```bash
npm run metrics:check
```
