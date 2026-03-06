# Maintainer Architecture Guide

更新时间：2026-03-06

这份文档面向维护者，重点解释当前最容易继续膨胀、也最需要守住边界的三组模块：`hybrid-* / retrieval-*`、`mcp-*`、`index-watch-*`。

目标不是重复用户手册，而是帮助后续开发者快速回答三件事：

1. 功能应该放在哪一层。
2. 出问题时应从哪条链路排查。
3. 改动时哪些契约不能破坏。

## 一、整体分层

当前核心分层建议按下面理解：

- `src/index.js`：CLI 装配层，负责命令入口和对外暴露。
- `src/agent.js`：Agent 会话层，负责 prompt、模型调用、工具循环、记忆与增量上下文。
- `src/tools.js`：工具总线，负责把本地工具和检索工具组合成统一调用面。
- `src/code-index.js` / `src/syntax-index.js` / `src/semantic-graph.js` / `src/vector-index.js`：基础索引实现层。
- `src/hybrid-*` / `src/retrieval-*`：多路检索编排、融合排序、结果协议与回放评测层。
- `src/index-watch-*`：文件变化监听、脏队列、增量刷新、反压与 watch 观测层。
- `src/mcp-*`：把检索、分析、监控能力包装成 MCP 服务的对外暴露层。

维护原则：

- CLI/Agent 层负责“调度与体验”，不承载底层检索实现细节。
- 索引实现层负责“单一路径的事实来源”，不直接关心多路融合策略。
- Hybrid/Retrieval 层负责“多源合并和可解释输出”，不直接承担 MCP 传输职责。
- MCP 层负责“协议暴露与权限边界”，不重新实现检索逻辑。
- Watch 层负责“增量新鲜度”，不承担查询排序逻辑。

## 二、`hybrid-*` / `retrieval-*` 模块簇

### 角色分工

- `src/retrieval-orchestrator.js`：并发查询 semantic / syntax / code / vector 等来源，并把原始结果汇总成待融合候选。
- `src/hybrid-query-pipeline.js`：承担完整 hybrid 查询主链路，串起召回、排序、降级、可观测信息与最终响应结构。
- `src/hybrid-ranking.js` / `src/hybrid-rerank.js`：负责融合排序与重排策略。
- `src/retrieval-result-protocol.js` / `src/hybrid-source-status.js`：负责把结果解释信息标准化，形成对外契约。
- `src/hybrid-replay.js`：负责回放评测和质量回归闭环。

### 边界约束

- 新的检索来源，优先接入 orchestrator/pipeline，而不是在 CLI、MCP 或单个工具 handler 中直接拼装。
- 新的排序或降级策略，应优先落在 `hybrid-*` 模块，不应散落到 `tools.js` 或上层入口。
- 对外返回的 retrieval explain/source/confidence/timeliness/dedup 字段视为稳定契约，不能因内部重构被删减。
- failure sample、baseline、metrics check 属于该模块簇的配套机制；功能优化应同步考虑它们，而不是只改召回逻辑。

### 推荐排查顺序

当 hybrid 结果异常时，按这个顺序看：

1. `retrieval-orchestrator` 是否正确拿到各来源结果。
2. `hybrid-ranking` / `hybrid-rerank` 是否因参数或降权逻辑导致排序异常。
3. `retrieval-result-protocol` 是否把来源状态和解释字段写完整。
4. `hybrid-replay` 与 metrics 是否能复现或量化问题。

## 三、`mcp-*` 模块簇

### 角色分工

- `src/mcp-server.js`：MCP 服务装配入口，不应重新承担大段业务逻辑。
- `src/mcp-server-cli.js` / `src/mcp-server-options.js` / `src/mcp-server-runtime-options.js`：CLI 参数、运行时选项与配置解析。
- `src/mcp-tool-definitions.js` / `src/mcp-tool-dispatch.js` / `src/mcp-tool-runtime.js`：工具定义、调度执行、运行时上下文。
- `src/mcp-toolset-policy.js`：控制不同工具集暴露范围和权限边界。
- `src/mcp-search-facade.js` / `src/mcp-analysis-facades.js` / `src/mcp-monitor-tools.js` / `src/mcp-reindex-facade.js`：按场景封装能力，而不是把所有逻辑堆回 server 入口。
- `src/mcp-transport-*` / `src/mcp-server-rpc.js`：传输与 RPC 支撑。

### 边界约束

- 新增 MCP 能力时，优先复用已有 facade 或新增 facade，不直接在 `mcp-server.js` 堆分支。
- 权限与工具暴露策略统一经过 `mcp-toolset-policy.js`，不要在多个入口重复判断。
- MCP 层复用现有检索/监控/分析能力，不复制一套平行实现。
- 任何低层工具暴露都要先经过“是否应对外公开”的判断，而不是因为本地可用就直接暴露给 MCP 客户端。

### 推荐排查顺序

当 MCP 行为异常时，按这个顺序看：

1. CLI 参数和 runtime options 是否生成了预期配置。
2. toolset policy 是否把能力拦掉或裁剪掉。
3. dispatch/runtime 是否正确把请求转到 facade。
4. facade 下游复用的本地能力是否本身就失败。

## 四、`index-watch-*` 模块簇

### 角色分工

- `src/index-watch.js`：watch 主入口与组合层。
- `src/index-watch-config.js`：watch 参数解析与默认值收敛。
- `src/index-watch-path-policy.js`：路径筛选策略。
- `src/index-watch-snapshot.js` / `src/index-watch-hash.js`：文件快照与 hash 去重。
- `src/index-watch-queue.js`：脏队列、批处理、flush 条件。
- `src/index-watch-refresh.js`：触发 code/syntax/semantic/vector 刷新。
- `src/index-watch-loop.js`：轮询、反压、动态 debounce。
- `src/index-watch-flush.js` / `src/index-watch-metrics.js`：flush 过程与观测数据。

### 边界约束

- watch 相关新逻辑优先进入对应子模块，不回填到 `index-watch.js` 形成第二次膨胀。
- 队列策略、反压策略、刷新策略、路径策略应分开维护，避免一个文件同时承载状态机和索引实现细节。
- watch 层只负责“发现变化并把索引刷新到最新”，不负责查询排序或结果解释。
- 任何引入成本较高的新刷新行为，都需要同步考虑 metrics、backpressure 和大仓场景。

### 推荐排查顺序

当 watch 刷新不符合预期时，按这个顺序看：

1. path policy 是否错误过滤了文件。
2. snapshot/hash 是否把真实变化误判成无需刷新。
3. queue/flush 是否因为 debounce、batch 或 backpressure 延迟执行。
4. refresh 子链路是否在 code/syntax/semantic/vector 某一步失败。
5. metrics 是否记录出 lag、flush 率或重试异常。

## 五、改动放置规则

可以用下面的快速判断：

- “这是新命令或对外入口吗？” → 优先看 `src/index.js`、`src/mcp-server-cli.js`
- “这是多路检索的融合、排序、解释吗？” → 优先看 `src/hybrid-*`、`src/retrieval-*`
- “这是某个索引本身的构建/查询/刷新吗？” → 优先看具体 index 模块
- “这是代码变化后如何增量刷新吗？” → 优先看 `src/index-watch-*`
- “这是给外部 MCP 客户端开放能力吗？” → 优先看 `src/mcp-*`

如果一个改动同时碰到多个模块簇，优先守住这些原则：

- 不要为求方便把 orchestration 写回入口文件。
- 不要让 MCP 层重新实现 hybrid 或 index 行为。
- 不要让 watch 层知道太多查询细节。
- 不要让单个索引模块承担跨源融合职责。

## 六、默认非回归检查

涉及这三组模块的改动，默认至少执行：

```bash
npm run lint
npm run contract:check
npm run typecheck
npm test
```

如改动影响 retrieval / watch 质量判断，建议再执行：

```bash
npm run metrics:check
```

## 七、后续建议

- 后续如果继续扩展 `hybrid-*`、`mcp-*`、`index-watch-*`，优先补充“模块职责”和“改动放置规则”，再增加实现。
- 若某个入口文件重新开始堆业务分支，应优先考虑再拆分，而不是继续容忍膨胀。
- 当新增新能力难以归位时，先回到本文档判断它属于“装配层、实现层、编排层、暴露层、增量刷新层”中的哪一层。
