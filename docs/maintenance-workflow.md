# Maintenance Workflow

更新时间：2026-03-06

本文定义日常维护的默认动作：什么时候更新文档、跑哪些门禁、哪些改动必须补测试。

## 1. 何时更新文档

### 更新 `docs/project-status.md`

触发条件：

- 项目阶段判断变化。
- 当前主线从 retrieval/watch/MCP 等方向切换。
- 对外稳定能力集合变化。
- 主要风险或非回归约束变化。

### 更新 `docs/maintainer-architecture.md`

触发条件：

- `hybrid-*`、`mcp-*`、`index-watch-*` 职责边界变化。
- 推荐排查顺序失效。
- 改动放置规则发生调整。

### 更新使用文档（`README.md` / `docs/usage.md`）

触发条件：

- 公共命令行为、参数、错误提示变化。
- 配置默认值、环境变量或优先级变化。
- 典型工作流发生变化。

## 2. 默认维护流程

1. 判断改动属于哪一层（CLI / Agent / Index / Retrieval / Watch / MCP）。
2. 先改代码与测试，再同步文档。
3. 运行默认门禁。
4. 在 PR 描述记录“验证命令 + 关键结论 + 风险点”。

## 3. 默认门禁

核心改动至少执行：

```bash
npm run lint
npm run contract:check
npm run typecheck
npm test
```

影响检索/watch/指标时建议补：

```bash
npm run metrics:check
```

影响专项质量基线时补对应门禁：

```bash
npm run bench:index:check
npm run bench:semantic:check
npm run bench:graph:check
npm run bench:graph:refresh:check
npm run bench:hybrid:check
npm run bench:hybrid:replay:check
npm run bench:hybrid:replay:failure:check
```

## 4. 必须补测试的改动

满足任一项时必须补测试：

- 新增/修改公共 CLI 行为。
- 工具输入输出契约变化。
- 索引构建、刷新、降级、缓存策略变化。
- hybrid 排序、解释字段或来源状态变化。
- watch 队列、反压、hash/snapshot、flush 逻辑变化。
- MCP 工具暴露、toolset policy、dispatch/runtime 变化。

## 5. 完成定义

一次维护改动满足以下条件后视为完成：

- 代码改动落在正确层级。
- 自动化检查执行完成并结果明确。
- 受影响文档已同步更新。
- PR 描述可复现验证过程。
