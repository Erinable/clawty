# Maintenance Workflow

更新时间：2026-03-06

这份清单面向日常维护，不替代专项发布清单，而是回答：**什么改动需要更新哪些文档、默认跑哪些检查、什么情况下必须补测试或质量验证。**

## 1. 什么时候更新哪些文档

### 更新 `docs/project-status.md`

满足任一情况时更新：

- 项目阶段判断发生变化，例如从“能力建设”转向“稳定性治理”或“发布收口”。
- 公开主线发生变化，例如当前优先级从 retrieval 转到 MCP、watch 或发布治理。
- 新增一类已经可对外稳定说明的核心能力。
- 主要风险、欠账、非回归约束发生变化。

更新要求：

- 保持“当前判断、已稳定能力、当前主线、主要风险、非回归约束、默认验证命令、下一阶段建议”结构稳定。
- 不把短期实现细节堆进状态文档，优先记录阶段判断和优先级变化。

### 更新 `docs/maintainer-architecture.md`

满足任一情况时更新：

- `hybrid-* / retrieval-*`、`mcp-*`、`index-watch-*` 中新增了新的职责层或新的专题模块。
- 某条链路的推荐排查顺序已经不再准确。
- 某类改动的最佳落点发生变化，需要调整“改动放置规则”。
- 入口文件再次出现明显膨胀，需要通过文档重新声明边界。

更新要求：

- 只写“职责、边界、排查顺序、放置规则”，不要把用户使用说明混进来。
- 新模块加入前，先明确它属于装配层、实现层、编排层、暴露层还是增量刷新层。

### 更新会话笔记（Codex 默认：`~/.codex/memories/codex_session_memory/clawty/SESSION_NOTES.md`）

满足任一情况时更新：

- 修复了一个值得防回归的问题。
- 调整了项目定位、维护约束或模块边界。
- 运行了关键验证命令，且结果值得沉淀。
- 完成了一轮阶段性收口、排障或架构整理。

更新要求：

- 记录实际运行过的命令，不写“理论上应该跑什么”。
- 新问题按 `Symptom / Root cause / Fix / Verification / Guardrail` 结构记录。

## 2. 默认维护流程

对日常改动，默认按下面顺序自检：

1. 先判断改动属于哪一层：CLI/Agent、Index、Hybrid/Retrieval、Watch、MCP。
2. 如果改动影响项目对外认知，更新 `docs/project-status.md`。
3. 如果改动影响模块边界或职责放置，更新 `docs/maintainer-architecture.md`。
4. 如果改动修复了问题或形成了新约束，更新会话笔记（Codex 默认路径：`~/.codex/memories/codex_session_memory/clawty/SESSION_NOTES.md`）。
5. 跑默认门禁并在提交/PR 中记录验证结果。

## 3. 默认门禁命令

影响核心能力的改动，默认至少执行：

```bash
npm run lint
npm run contract:check
npm run typecheck
npm test
```

如改动影响检索质量、watch 新鲜度或观测阈值，建议再执行：

```bash
npm run metrics:check
```

如改动影响专项基线，再补对应命令，例如：

```bash
npm run bench:hybrid:replay:check
npm run bench:index:check
npm run bench:semantic:check
npm run bench:graph:check
npm run bench:graph:refresh:check
```

## 4. 哪类改动必须补测试

满足任一情况时，必须补测试或更新已有测试：

- 新增公开 CLI 行为、参数或错误提示。
- 改动了工具输入输出契约。
- 改动了索引构建、刷新、降级或缓存行为。
- 改动了 hybrid 排序、重排、可解释字段或来源状态。
- 改动了 watch 队列、flush、backpressure、hash/snapshot 逻辑。
- 改动了 MCP 暴露能力、toolset policy、dispatch 或 runtime 逻辑。

优先原则：

- 优先补最接近改动点的模块测试。
- 若改动跨多个模块簇，再补一层集成测试。
- 不为无关模块顺手改测试，避免扩大变更面。

## 5. 哪类改动必须补质量验证

满足任一情况时，除常规测试外，还应补质量验证：

- 改动了 hybrid 召回、排序、重排或 explain 输出。
- 改动了 semantic / syntax / index / vector 的降级链路。
- 改动了 watch 增量刷新策略，尤其是 batch、debounce、backpressure、retry。
- 改动了 metrics 结构、阈值判断或 report/check 逻辑。

推荐验证方式：

- 检索主线：`metrics:check` + 对应 replay / benchmark check。
- watch 主线：`metrics:check` + watch 相关测试。
- release 前：结合 `docs/code-index-release-checklist.md` 做专项核对。

## 6. 完成定义

一项维护性或核心行为改动，满足以下条件后再视为完成：

- 代码或文档改动已经落到正确层级。
- 相关自动化检查已经执行并结果明确。
- 若影响对外认知，`docs/project-status.md` 已同步。
- 若影响模块边界，`docs/maintainer-architecture.md` 已同步。
- 若产生新经验或新约束，会话笔记已同步（Codex 默认路径：`~/.codex/memories/codex_session_memory/clawty/SESSION_NOTES.md`）。

## 7. 和现有文档的关系

- `docs/project-status.md`：回答“项目现在处于什么阶段、当前重点是什么”。
- `docs/maintainer-architecture.md`：回答“模块职责怎么分、改动应该放哪”。
- `docs/code-index-release-checklist.md`：回答“专项发布前要跑哪些更细的发布门禁”。
- 会话笔记（Codex 默认路径：`~/.codex/memories/codex_session_memory/clawty/SESSION_NOTES.md`）：回答“这次具体改了什么、踩了什么坑、下次要避免什么”。
