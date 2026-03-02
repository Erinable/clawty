import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import {
  buildCodeIndex,
  queryCodeIndex,
  refreshCodeIndex
} from "../src/code-index.js";
import {
  createWorkspace,
  removeWorkspace,
  writeWorkspaceFile
} from "./helpers/workspace.js";

function normalizeResultSignature(result, limit = 10) {
  return (result.results || [])
    .slice(0, limit)
    .map((item) => `${item.path}#${item.hit_line}`)
    .join("|");
}

async function applyMutationBatch(workspaceRoot) {
  await writeWorkspaceFile(
    workspaceRoot,
    "src/services/user-service.js",
    "export function createUserProfile(payload) { return { ...payload, version: 2 }; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/controllers/user-controller.ts",
    "import { createUserProfile } from '../services/user-service.js';\nexport function handleCreateUser(input: { id: string; name: string }) { return createUserProfile(input); }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/utils/route-map.js",
    "export const ROUTE_USER_PROFILE = '/users/:id/profile';\nexport const ROUTE_BILLING = '/billing/invoices';\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "scripts/user_worker.py",
    "def sync_user_profile(user_id):\n    return f'sync:{user_id}'\n\ndef rebuild_invoice_cache(invoice_id):\n    return invoice_id\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "packages/payments/payment_service.go",
    "package payments\n\nfunc ChargeInvoice(invoiceID string) string {\n\treturn invoiceID + \"-charged\"\n}\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "docs/user-guide.md",
    "# User Guide\n\ncreate user workflow and route mapping details.\n"
  );

  await fs.rm(path.join(workspaceRoot, "src/legacy/old-service.js"), { force: true });
  await fs.rm(path.join(workspaceRoot, "docs/legacy.md"), { force: true });

  await writeWorkspaceFile(
    workspaceRoot,
    "src/new/new-feature.js",
    "export const generated_feature_01 = true;\n"
  );
}

async function seedWorkspace(workspaceRoot) {
  await writeWorkspaceFile(
    workspaceRoot,
    "src/services/user-service.js",
    "export function createUserProfile(payload) { return payload; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/controllers/user-controller.ts",
    "export function handleCreateUser(input: { id: string; name: string }) { return input; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/utils/route-map.js",
    "export const ROUTE_USER_PROFILE = '/users/:id/profile';\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "src/legacy/old-service.js",
    "export function removeMeLater() { return true; }\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "scripts/user_worker.py",
    "def sync_user_profile(user_id):\n    return user_id\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "packages/payments/payment_service.go",
    "package payments\n\nfunc ChargeInvoice(invoiceID string) string {\n\treturn invoiceID\n}\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "docs/user-guide.md",
    "# User Guide\n\ncreate user workflow.\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "docs/legacy.md",
    "legacy migration notes and old routing.\n"
  );
}

const QUERY_CASES = [
  { query: "createUserProfile", top_k: 8 },
  { query: "handleCreateUser", top_k: 8, language: "javascript" },
  { query: "ROUTE_USER_PROFILE", top_k: 8, path_prefix: "src" },
  { query: "sync_user_profile", top_k: 8, language: "python" },
  { query: "ChargeInvoice", top_k: 8, language: "go" },
  { query: "generated_feature_01", top_k: 8 },
  { query: "legacy migration notes", top_k: 8, path_prefix: "docs" }
];

async function collectQuerySignatures(workspaceRoot) {
  const signatures = new Map();
  for (const args of QUERY_CASES) {
    const result = await queryCodeIndex(workspaceRoot, args);
    assert.equal(result.ok, true);
    signatures.set(JSON.stringify(args), {
      total_hits: result.total_hits,
      signature: normalizeResultSignature(result, 8)
    });
  }
  return signatures;
}

function assertSignatureMapsEqual(base, target, label) {
  assert.equal(target.size, base.size, `${label}: signature map size mismatch`);
  for (const [key, expected] of base.entries()) {
    const actual = target.get(key);
    assert.ok(actual, `${label}: missing query signature for ${key}`);
    assert.equal(actual.total_hits, expected.total_hits, `${label}: total_hits mismatch for ${key}`);
    assert.equal(actual.signature, expected.signature, `${label}: top result signature mismatch for ${key}`);
  }
}

test("incremental refresh query signatures match full rebuild", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await seedWorkspace(workspaceRoot);
  const built = await buildCodeIndex(workspaceRoot, {});
  assert.equal(built.ok, true);

  await new Promise((resolve) => setTimeout(resolve, 20));
  await applyMutationBatch(workspaceRoot);

  const incremental = await refreshCodeIndex(workspaceRoot, {});
  assert.equal(incremental.ok, true);
  assert.equal(incremental.mode, "incremental");
  const incrementalSignatures = await collectQuerySignatures(workspaceRoot);

  const rebuilt = await buildCodeIndex(workspaceRoot, {});
  assert.equal(rebuilt.ok, true);
  const fullSignatures = await collectQuerySignatures(workspaceRoot);

  assertSignatureMapsEqual(fullSignatures, incrementalSignatures, "incremental_vs_full");
});

test("event refresh query signatures match full rebuild", async (t) => {
  const workspaceRoot = await createWorkspace();
  t.after(async () => {
    await removeWorkspace(workspaceRoot);
  });

  await seedWorkspace(workspaceRoot);
  const built = await buildCodeIndex(workspaceRoot, {});
  assert.equal(built.ok, true);

  await new Promise((resolve) => setTimeout(resolve, 20));
  await applyMutationBatch(workspaceRoot);

  const eventRefresh = await refreshCodeIndex(workspaceRoot, {
    changed_paths: [
      "src/services/user-service.js",
      "src/controllers/user-controller.ts",
      "src/utils/route-map.js",
      "scripts/user_worker.py",
      "packages/payments/payment_service.go",
      "docs/user-guide.md",
      "src/new/new-feature.js"
    ],
    deleted_paths: ["src/legacy/old-service.js", "docs/legacy.md"]
  });
  assert.equal(eventRefresh.ok, true);
  assert.equal(eventRefresh.mode, "event");

  const eventSignatures = await collectQuerySignatures(workspaceRoot);

  const rebuilt = await buildCodeIndex(workspaceRoot, {});
  assert.equal(rebuilt.ok, true);
  const fullSignatures = await collectQuerySignatures(workspaceRoot);

  assertSignatureMapsEqual(fullSignatures, eventSignatures, "event_vs_full");
});
