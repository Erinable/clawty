# Hybrid Embedding Degrade Runbook

用于 `query_hybrid_index` embedding 二阶段重排降级事件（`sources.embedding.status_code`）的故障分流与处置。

## 1. 分流口径

| status_code | 分类 | 是否失败 | 默认动作 |
| --- | --- | --- | --- |
| `EMBEDDING_OK` | ok | 否 | 无需处理 |
| `EMBEDDING_DISABLED` | disabled | 否 | 检查是否预期开关关闭 |
| `EMBEDDING_NOT_ATTEMPTED_NO_API_KEY` | misconfig | 否 | 检查 `CLAWTY_EMBEDDING_API_KEY`/`OPENAI_API_KEY` |
| `EMBEDDING_NOT_ATTEMPTED_NO_CANDIDATES` | no_candidates | 否 | 检查上游候选召回 |
| `EMBEDDING_ERROR_TIMEOUT` | timeout | 是 | 提高超时/降并发/重试 |
| `EMBEDDING_ERROR_NETWORK` | network | 是 | 检查网络连通性与 DNS/TLS |
| `EMBEDDING_ERROR_API` | api | 是 | 检查 provider 可用性、限流、鉴权 |
| `EMBEDDING_ERROR_RESPONSE` | response | 是 | 检查响应 schema 与 provider 兼容性 |
| `EMBEDDING_ERROR_INPUT` | input | 是 | 检查输入长度、内容清洗逻辑 |
| `EMBEDDING_ERROR_UNKNOWN` | unknown | 是 | 先归类再补充 runbook |

说明：

1. `metrics:report` 会按 timeout/network/api/unknown 聚合速率。
2. `metrics:check --runbook-enforce` 会在出现未映射 `status_code` 时直接失败。

## 2. 快速诊断流程

1. 先看 `npm run metrics:report -- --json` 中：
   - `kpi.embedding_timeout_rate`
   - `kpi.embedding_network_rate`
   - `kpi.embedding_api_rate`
   - `kpi.embedding_unknown_rate`
2. 再看 `runbook.embedding_unmapped_status_codes` 是否为空。
3. 若 `unknown_rate` 或 unmapped 非零，优先抽样 `.clawty/metrics/hybrid-query.jsonl` 最近事件定位具体 `status_code`/`error_code`。

## 3. 分类处置建议

### timeout

1. 提高 `CLAWTY_EMBEDDING_TIMEOUT_MS`（例如 `15000 -> 25000`）。
2. 降低 `embedding_top_k`，减少重排候选量。
3. 短期可将 `enable_embedding=false`，保持主链路可用。

### network

1. 校验 `CLAWTY_EMBEDDING_BASE_URL` 与 DNS。
2. 检查代理、TLS 证书、出口网络策略。
3. 在 CI/容器环境复现并记录失败窗口。

### api

1. 检查 key 权限、配额、速率限制。
2. 检查 provider 状态页和错误返回。
3. 必要时切换模型或备用 endpoint。

### response / input / unknown

1. 抽样原始事件，确认返回 schema 或输入特征。
2. 对可复现样本补单测（`tests/tools.test.js` 或 `tests/metrics-*.test.js`）。
3. 新状态码必须补充本 runbook 与 `scripts/hybrid-degrade-runbook.mjs` 映射。

## 4. 恢复与回归检查

1. 执行 `npm run metrics:check -- --runbook-enforce`。
2. 执行 `npm run bench:hybrid:check`。
3. 确认主链路指标仍达标：
   - `code_index_lag_p95_ms`
   - `stale_hit_rate_avg`
   - `query_hybrid_p95_ms`
   - `degrade_rate`
