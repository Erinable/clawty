import test from "node:test";
import assert from "node:assert/strict";
import {
  dashboardPayloadHasError,
  renderDashboardPage,
  shouldRenderMetricsEmptyState
} from "../src/dashboard-html.js";

test("dashboard page includes optimized index sections", () => {
  const page = renderDashboardPage();

  assert.match(page, /Largest Indexed Files/);
  assert.match(page, /Top Imported Modules/);
  assert.match(page, /Latest Run/);
  assert.match(page, /index-kpi-grid/);
  assert.match(page, /Project config editor for the active workspace/);
  assert.match(page, /MCP server log/);
  assert.match(page, /Current session/);
  assert.match(page, /metrics-window-btn/);
  assert.match(page, /Last 24 hours/);
  assert.match(page, /Data Availability/);
  assert.match(page, /Memory Hit Rate/);
  assert.match(page, /No hybrid query samples yet/);
  assert.match(page, /Effective config refresh failed:/);
});

test("dashboard payload helper treats ok=false as a load failure", () => {
  assert.equal(dashboardPayloadHasError(null), false);
  assert.equal(dashboardPayloadHasError({ model: "gpt-4.1-mini" }), false);
  assert.equal(dashboardPayloadHasError({ ok: true }), false);
  assert.equal(dashboardPayloadHasError({ ok: false, error: "invalid runtime config" }), true);
});

test("metrics empty-state helper preserves timeline fallback charts when sample sizes are missing", () => {
  const emptyTimeline = {
    hybrid: [],
    watch_flush: [],
    memory: []
  };
  const populatedTimeline = {
    hybrid: [{ avg_latency_ms: 42 }],
    watch_flush: [],
    memory: []
  };

  assert.equal(shouldRenderMetricsEmptyState(emptyTimeline, undefined), false);
  assert.equal(shouldRenderMetricsEmptyState(populatedTimeline, undefined), false);
  assert.equal(
    shouldRenderMetricsEmptyState(emptyTimeline, {
      hybrid_events: 0,
      watch_flush_events: 0,
      memory_events: 0
    }),
    true
  );
});
