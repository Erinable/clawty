# Clawty 用法文档

面向“日常写代码”的实用手册，按真实使用流程组织。

## 1. 快速开始（5 分钟）

1. 初始化环境变量：

```bash
cp .env.example .env
# 编辑 .env，至少配置 OPENAI_API_KEY
```

2. 查看帮助：

```bash
node src/index.js --help
```

3. 新仓库一键初始化（推荐）：

```bash
node src/index.js init
```

4. 单次任务执行：

```bash
node src/index.js run "读取 package.json 并总结这个项目"
```

5. 进入多轮模式：

```bash
node src/index.js chat
```

## 2. 常用命令

```bash
# 交互模式
node src/index.js chat

# 单次模式
node src/index.js run "your task"

# 新仓库一键初始化（doctor + code/syntax/semantic）
node src/index.js init
node src/index.js init --include-vector

# 查看生效配置（敏感字段脱敏）
node src/index.js config show
node src/index.js config path --json
node src/index.js config validate

# 长期记忆（搜索/统计/解释/反馈/清理）
node src/index.js memory search "auth retry" --top-k 5
node src/index.js memory search "auth retry" --top-k 5 --explain
node src/index.js memory stats
node src/index.js memory inspect 12
node src/index.js memory feedback 12 --vote up --reason good --note "worked"
node src/index.js memory prune --days 90
node src/index.js memory reindex

# 运行本地健康诊断
node src/index.js doctor
node src/index.js doctor --json

# 实时索引监听
node src/index.js watch-index

# 生成 shell completion
node src/index.js completion bash

# 升级 / 卸载（谨慎执行）
node src/index.js upgrade
node src/index.js uninstall --yes --skip-npm

# 构建单文件二进制（实验）
npm run build:bin
```

二进制构建前置：

```bash
npm i -D esbuild postject
```

构建后推荐通过启动器运行（默认抑制 Node ExperimentalWarning）：

```bash
./dist/clawty --help
./dist/clawty doctor
```

配置加载优先级（高 -> 低）：

1. 系统环境变量
2. `.env`
3. 项目配置 `.clawty/config.json`（兼容旧路径 `clawty.config.json`）
4. 全局配置 `~/.clawty/config.json`
5. 内置默认值

## 3. 推荐工作流（最常用）

### 工作流 A：首次进入仓库，先建立检索能力

优先直接执行：

```bash
node src/index.js init
```

如果需要向量检索底座：

```bash
node src/index.js init --include-vector
```

然后在 `chat` 模式中输入：

1. “先构建代码索引，再告诉我索引统计信息”
2. “再构建 syntax index 和 semantic graph”
3. “查询和支付重试逻辑相关的 Top5 文件”

效果：模型会自动调用 `build_*` / `query_*` 工具，把仓库上下文先搭起来。

### 工作流 B：改完代码后，刷新再分析

在 `chat` 模式中输入：

1. “代码已变更，刷新 code/syntax/semantic 索引”
2. “用 query_hybrid_index 检索受影响路径并给出风险点”
3. “运行测试并总结失败原因”

效果：避免模型基于旧上下文推理，减少“改了但没看到”的误判。

### 工作流 C：定位定义、引用与影响面

在 `chat` 模式中输入：

1. “对 `src/tools.js` 第 N 行做 definition 跳转”
2. “查这个符号的 references（不含声明）”
3. “给出这个符号变更的影响文件清单”

效果：优先走 LSP；LSP 不可用时自动回退索引检索。

### 工作流 D：把“这次排障经验”沉淀成可复用记忆

1. 用 `memory search` 先查有没有历史经验可复用。
2. 完成任务后在 `chat/run` 中自动写入一条经验（默认开启）。
3. 对检索命中的经验用 `memory feedback` 投票，提升后续排序。
4. 定期 `memory prune --days 90` 清理过期条目。

## 4. 实时索引监听（watch-index）

适合你边改边让 AI 分析的场景。

```bash
# 默认参数启动
node src/index.js watch-index

# 高频改动场景建议
node src/index.js watch-index --interval-ms 1000 --max-batch-size 200 --debounce-ms 500

# 需要向量增量时开启
node src/index.js watch-index --include-vector true --vector-layer delta
```

说明：

1. `watch-index` 会自动刷新 `code -> syntax -> semantic`（vector 可选）。
2. 支持脏队列、batch、debounce、hash skip，减少重复刷新。
3. 返回 `watch_metrics`，可用于观察索引滞后与队列深度。

## 5. 高质量提问模板（直接可用）

1. “先构建索引，再查找和 `apply_patch` 相关实现，给我 Top5 并解释排序理由。”
2. “代码改完后刷新索引，找出和本次改动 `changed_paths` 相关的潜在回归点。”
3. “用 `query_hybrid_index`（开启 embedding/freshness）查 `xxx`，返回证据链。”
4. “如果语义图为空，请按 syntax -> index 回退并继续完成分析。”

## 6. 观测与门禁（发布前）

```bash
# 全量测试
npm test

# 覆盖率门禁
npm run coverage:check

# 指标报表（最近 24h）
npm run metrics:report

# 指标阈值门禁
npm run metrics:check

# embedding 分流门禁（示例）
npm run metrics:check -- --max-embedding-timeout-rate=0.05 --max-embedding-network-rate=0.03 --min-embedding-attempts=50 --runbook-enforce
```

说明：

1. `metrics:report` 会输出 embedding 分流指标（timeout/network/api/unknown）。
2. `metrics:check` 可按样本量启用 embedding 阈值门禁，避免低样本误报。
3. `--runbook-enforce` 会在出现未映射 embedding `status_code` 时直接失败，便于及时补 runbook。
4. runbook 见 `docs/hybrid-degrade-runbook.md`。

## 7. 常见问题

### Q1：为什么回答有时“像没看到最新改动”？

优先检查：

1. 是否执行了 `refresh_*` 或开启了 `watch-index`。
2. 当前 `git diff` 是否过大导致注入被截断。
3. 是否在不同工作目录运行了 CLI。

### Q2：LSP 不可用怎么办？

1. 安装并检查 `typescript-language-server`。
2. 使用 `lsp_health` 检查服务状态。
3. 即使 LSP 不可用，也可继续使用索引回退链路。

### Q3：向量检索效果不稳定？

1. 先确认 embedding 配置和 API 可用。
2. 用 `build_vector_index` 建 base，变更后用 delta 刷新并定期 merge。
3. 在 `query_hybrid_index` 里配合 freshness，避免 stale 向量干扰。

### Q4：长期记忆检索不到历史经验？

1. 先检查是否开启了 `CLAWTY_MEMORY_ENABLED=true`。
2. 检查作用域：`--scope project|global|project+global`。
3. 用 `node src/index.js memory stats --json` 查看当前记忆库条目是否存在。
4. 如历史经验过多，调大 `--top-k` 或在配置中提高 `maxInjectedItems`。

## 8. 当前边界

1. 目前是本地 CLI 形态，不是 MCP Server 形态。
2. 长期记忆已是 MVP 形态，当前仍需继续优化学习策略与排序质量。
