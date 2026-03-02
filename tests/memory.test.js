import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createWorkspace,
  removeWorkspace
} from "./helpers/workspace.js";
import {
  recordEpisode,
  recordLesson,
  searchMemory,
  getMemoryStats,
  recordFeedback,
  pruneMemory,
  formatMemoryContextForPrompt
} from "../src/memory.js";

function memoryOptions(homeDir) {
  return {
    homeDir,
    env: {
      HOME: homeDir,
      USERPROFILE: homeDir
    }
  };
}

test("memory records lessons and supports search/context formatting", async (t) => {
  const workspaceRoot = await createWorkspace();
  const fakeHome = path.join(workspaceRoot, "fake-home");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const options = memoryOptions(fakeHome);
  const lesson = await recordLesson(
    workspaceRoot,
    {
      title: "Auth retry strategy",
      lesson: "When login fails with 401, refresh token and retry once.",
      tags: ["auth", "retry"],
      refs: [{ file_path: "src/auth.js", line_start: 12, line_end: 40 }]
    },
    options
  );
  assert.equal(lesson.ok, true);

  const result = await searchMemory(workspaceRoot, "auth retry", {
    ...options,
    scope: "project",
    topK: 5
  });
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.items));
  assert.ok(result.items.length >= 1);
  assert.equal(result.items[0].workspace_match, true);
  assert.deepEqual(result.items[0].tags, ["auth", "retry"]);

  const prompt = formatMemoryContextForPrompt(result, { maxChars: 1200 });
  assert.match(prompt, /\[memory_context\]/);
  assert.match(prompt, /Auth retry strategy/);
});

test("memory search handles hyphenated tokens safely", async (t) => {
  const workspaceRoot = await createWorkspace();
  const fakeHome = path.join(workspaceRoot, "fake-home");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const options = memoryOptions(fakeHome);
  const lesson = await recordLesson(
    workspaceRoot,
    {
      title: "OAuth2 CI/CD guidance",
      lesson: "For oauth-2 rollout in ci-cd pipeline, keep token refresh retry guarded.",
      tags: ["oauth-2", "ci-cd"]
    },
    options
  );
  assert.equal(lesson.ok, true);

  const result = await searchMemory(workspaceRoot, "oauth-2 ci-cd", {
    ...options,
    scope: "project",
    topK: 5
  });
  assert.equal(result.ok, true);
  assert.ok(result.items.length >= 1);
  assert.match(result.items[0].lesson, /oauth-2/i);
});

test("memory tracks episodes, feedback, and stats", async (t) => {
  const workspaceRoot = await createWorkspace();
  const fakeHome = path.join(workspaceRoot, "fake-home");
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  const options = memoryOptions(fakeHome);
  const lesson = await recordLesson(
    workspaceRoot,
    {
      title: "Patch workflow",
      lesson: "Use apply_patch for focused edits and run tests after changes.",
      tags: ["patch", "tests"]
    },
    options
  );
  assert.equal(lesson.ok, true);

  const episode = await recordEpisode(
    workspaceRoot,
    {
      session_id: "session-1",
      turn_no: 1,
      user_query: "fix flaky test",
      assistant_summary: "Applied patch and reran tests",
      outcome: "success",
      tool_calls: [{ name: "apply_patch", ok: true }]
    },
    options
  );
  assert.equal(episode.ok, true);

  const feedback = await recordFeedback(workspaceRoot, lesson.id, "up", "works", options);
  assert.equal(feedback.ok, true);

  const stats = await getMemoryStats(workspaceRoot, {
    ...options,
    scope: "project"
  });
  assert.equal(stats.ok, true);
  assert.ok(stats.counts.lessons >= 1);
  assert.ok(stats.counts.episodes >= 1);
  assert.ok(stats.counts.feedback >= 1);
  const tagNames = stats.top_tags.map((item) => item.tag);
  assert.ok(tagNames.includes("patch"));
  assert.ok(tagNames.includes("tests"));
});

test("memory supports project/global scope and pruning", async (t) => {
  const workspaceA = await createWorkspace("clawty-a-");
  const workspaceB = await createWorkspace("clawty-b-");
  const fakeHome = path.join(workspaceA, "fake-home");
  t.after(async () => {
    await removeWorkspace(workspaceA);
    await removeWorkspace(workspaceB);
  });

  const options = memoryOptions(fakeHome);

  await recordLesson(
    workspaceA,
    {
      title: "Repo A lesson",
      lesson: "A specific note",
      tags: ["repo-a"],
      updated_at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString()
    },
    options
  );

  await recordLesson(
    workspaceB,
    {
      title: "Repo B lesson",
      lesson: "Cross-project strategy",
      tags: ["repo-b"]
    },
    options
  );

  const projectOnly = await searchMemory(workspaceA, "strategy", {
    ...options,
    scope: "project"
  });
  assert.ok(projectOnly.items.every((item) => item.workspace_match));

  const globalOnly = await searchMemory(workspaceA, "strategy", {
    ...options,
    scope: "global"
  });
  assert.ok(globalOnly.items.every((item) => !item.workspace_match));

  const pruned = await pruneMemory(workspaceA, {
    ...options,
    scope: "project",
    days: 30
  });
  assert.equal(pruned.ok, true);
  assert.ok(pruned.removed_lessons >= 1);
});
