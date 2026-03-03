# Hybrid Replay Evaluation

更新时间：2026-03-03

`hybrid replay` 用于对同一批 query case 按多套策略参数（preset）做离线回放，并输出可对比的质量/降级指标。

默认输入：

- 用例集：`tests/fixtures/hybrid-cases/expected.json`
- 策略集：`tests/fixtures/hybrid-cases/replay-presets.json`
- 基线：`tests/bench/hybrid-replay.baseline.json`

## 常用命令

```bash
npm run bench:hybrid:replay
npm run bench:hybrid:replay:check
npm run bench:hybrid:replay:baseline
```

原始脚本支持附加参数：

```bash
node tests/bench/hybrid-replay.bench.js --json
node tests/bench/hybrid-replay.bench.js --preset=baseline_fixture,freshness_aggressive
node tests/bench/hybrid-replay.bench.js --cases=tests/fixtures/hybrid-cases/expected.json
node tests/bench/hybrid-replay.bench.js --presets=tests/fixtures/hybrid-cases/replay-presets.json
```

## 输出结构

每个 preset 输出：

- `metrics`: 全局质量指标（`primary_top1_rate`、`primary_top3_rate`、`mean_reciprocal_rank`、`task_success_rate` 等）
- `bucket_metrics`: 四类分桶指标
  - `bucket`
  - `language`
  - `file_type`
  - `intent`
- `score`: 综合分（用于多 preset 排序）

## 基线门禁

`--check-baseline` 会校验每个 preset 的以下指标不低于基线 `threshold_percent`：

- `score`
- `task_success_rate`
- `primary_top1_rate`
- `mean_reciprocal_rank`

若任一指标回退超过阈值，脚本返回非 0 退出码。
