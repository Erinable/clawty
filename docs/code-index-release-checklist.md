# Code Index Release Checklist

发布索引相关能力前，按本清单逐项确认。

## 1. 变更范围确认

- [ ] 明确本次改动类型：`indexing` / `refresh` / `ranking` / `syntax` / `semantic` / `telemetry`
- [ ] 在 PR 中列出影响的输入输出字段或协议变更
- [ ] 若修改 baseline 或 fixture，说明原因与收益

## 2. 默认门禁

- [ ] `npm test`
- [ ] `npm run lint`
- [ ] `npm run contract:check`
- [ ] `npm run typecheck`
- [ ] `npm run coverage:check`

## 3. 索引专项门禁

- [ ] `npm run bench:index:check`
- [ ] `npm run bench:semantic:check`
- [ ] `npm run bench:graph:check`
- [ ] `npm run bench:graph:refresh:check`
- [ ] `npm run bench:hybrid:check`
- [ ] `npm run bench:hybrid:replay:coverage`
- [ ] `npm run bench:hybrid:replay:check`
- [ ] `npm run bench:hybrid:replay:failure:check`
- [ ] `npm run precise:check:fixture`
- [ ] `npm run precise:check`

## 4. 行为回归检查

- [ ] 回退链路稳定（`semantic -> syntax -> index`）
- [ ] explain 字段完整（source/confidence/timeliness/dedup 等）
- [ ] watch 增量刷新未引入明显滞后
- [ ] MCP 暴露策略未越权（默认 toolset 不扩张）

## 5. 基线更新规则

仅在“有意策略调整”时更新 baseline：

1. 先执行检查命令确认回归方向。
2. 再写 baseline（对应 `:baseline` 命令）。
3. 在 PR 描述附变更前后对比与 trade-off。

## 6. 发布记录

- [ ] PR 中记录已执行命令和关键输出摘要
- [ ] 标注风险点、回滚方案、观察窗口
- [ ] 如涉及 runbook，确认同步更新
