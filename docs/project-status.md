# Project Status

更新时间：2026-03-06

## 当前判断

Clawty 已进入“功能成型 + 工程化完善”阶段，当前重点不是补齐基础命令，而是继续推进产品收口、检索质量稳定、发布治理和维护性提升。

当前公开能力已覆盖：

- 本地 AI 编程助手 CLI（`chat` / `run` / `init` / `doctor`）
- 多路代码检索（code / syntax / semantic / vector / hybrid / LSP fallback）
- 增量上下文与 `watch-index` 自动刷新
- 长期记忆检索与自动写回
- metrics / monitor / contract / typecheck / test 等质量门禁
- MCP 服务对外暴露能力

## 已稳定能力

- CLI 主命令集合已稳定，README 与帮助信息均以 `chat`、`run`、`init`、`doctor`、`watch-index`、`memory`、`monitor`、`mcp-server` 为主入口。
- Agent 主循环已接入增量上下文、工具执行、长期记忆读写，形成多轮协作闭环。
- 检索能力已形成完整链路：关键词/符号检索、结构关系、语义图、多路融合、向量重排与 LSP 优先导航。
- 可观测链路已落地：运行日志、metrics、质量报表、阈值检查、回放基线与失败样本门禁。
- 安全边界已内建：工作区沙箱、危险命令拦截、MCP 工具策略、补丁路径校验。

## 当前主线

### 1) 产品收口

- 统一对外表述，避免 README、`package.json`、内部说明之间出现阶段性认知偏差。
- 控制公开命令面，优先在现有命令与配置体系内扩展，而不是继续增加一级入口。

### 2) 检索质量与稳定性

- 持续强化 retrieval / hybrid / replay 主链路。
- 把检索质量优化固定为“可回放、可比较、可解释”的工程流程。
- 强化 `watch-index` 在高频变更场景下的可预测性和一致性。

### 3) 发布治理

- 固化发布前默认门禁：`lint`、`contract:check`、`typecheck`、`test`、`metrics:report`、`metrics:check`。
- 为后续发布准备统一的状态文档、非回归约束和回放基线。

## 主要风险与欠账

- 项目描述曾长期停留在 “MVP” 表述，容易低估当前真实成熟度。
- 模块数量增长较快，`hybrid-*`、`mcp-*`、`index-watch-*` 已形成专题簇，需要持续控制边界。
- 部分维护流程还未完全制度化，尤其是会话记忆和项目状态沉淀。
- Node 运行时中的 SQLite 仍带有 experimental 警告，虽然当前不影响测试通过，但属于持续关注项。

## 非回归约束

- 不把项目重新退回为“单体 CLI 工具集”；保持现有分层结构与职责边界。
- 不随意扩大公开 CLI 一级命令面；优先保证现有命令稳定、好理解、可验证。
- 不破坏 retrieval protocol 的可解释性字段，包括 source、confidence、timeliness、dedup 等结构化信息。
- 所有影响索引、检索、watch、memory、MCP 的变更，都应以自动化检查或回放结果验证。

## 默认验证命令

建议在影响核心能力的改动后至少执行：

```bash
npm run lint
npm run contract:check
npm run typecheck
npm test
npm run metrics:check
```

## 下一阶段建议

- 扩充 hybrid replay 数据集与 failure samples，使质量回归更容易量化。
- 将 `docs/project-status.md`、`docs/maintainer-architecture.md` 和维护流程文档纳入“完成定义”，要求关键改动同步更新。
