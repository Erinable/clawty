# Project Status

更新时间：2026-03-06

## 当前阶段

项目处于“功能成型 + 工程化完善”阶段。

这意味着重点不是再扩一级命令，而是：

1. 稳定检索质量和回放基线。
2. 稳定增量刷新与观测闭环。
3. 稳定 MCP 暴露边界与对外行为。

## 已稳定的对外能力

- CLI 公开主命令：`chat`、`run`、`init`、`doctor`、`watch-index`、`config show`、`memory`、`monitor`、`mcp-server`
- 检索主链路：`code/syntax/semantic/vector/hybrid` + LSP 优先导航
- 增量新鲜度链路：`watch-index` 轮询、队列、反压、重试
- 记忆链路：检索、注入、自动写回、统计
- MCP 服务：`stdio/http`、toolset 策略、低层能力受控暴露
- 质量链路：`lint`、`contract:check`、`typecheck`、`test`、`metrics:check`、bench gates

## 当前主线

### 1) 产品收口

- 让 README、usage、help、配置示例保持同一口径。
- 控制公共 CLI 面，优先在现有命令中增强体验。

### 2) 检索质量稳定

- 扩展 `hybrid replay` 用例和失败样本。
- 把策略优化固定在“可回放、可比较、可解释”的流程内。

### 3) 发布治理

- 固化默认门禁和专项门禁。
- 强化 runbook 与 checklist 的执行一致性。

## 主要风险

- 文档和实现容易发生漂移（尤其是帮助文案、usage、runbook）。
- `hybrid-*`、`mcp-*`、`index-watch-*` 持续扩展时，边界容易再次膨胀。
- 大仓高频变更下，watch 刷新时延和 DB 重试仍需持续观测。
- Node SQLite experimental warning 仍存在，需要持续关注运行时兼容性。

## 非回归约束

- 不扩大公共 CLI 一级命令面。
- 不破坏 retrieval explain 协议核心字段。
- 不在 MCP 层复制检索实现逻辑。
- 不让 watch 层承担查询排序职责。
- 任何影响检索/watch/memory/MCP 的变更，都要有自动化验证。

## 默认验证命令

```bash
npm run lint
npm run contract:check
npm run typecheck
npm test
npm run metrics:check
```

## 下一阶段建议

- 扩展 `hybrid replay` 数据集覆盖语言、意图、查询模式。
- 增补 watch 指标趋势视图和告警阈值治理。
- 把文档更新纳入“完成定义”：实现改动完成前同步更新文档。
