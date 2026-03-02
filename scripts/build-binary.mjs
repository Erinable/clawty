import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const SEA_SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const BUILD_ROOT = path.resolve(process.cwd(), ".clawty", "build");
const DIST_ROOT = path.resolve(process.cwd(), "dist");
const SEA_BLOB_PATH = path.join(BUILD_ROOT, "sea-prep.blob");
const SEA_CONFIG_PATH = path.join(BUILD_ROOT, "sea-config.json");
const BUNDLE_PATH = path.join(BUILD_ROOT, "clawty.bundle.cjs");

function parseArgs(argv) {
  return {
    clean: argv.includes("--clean"),
    help: argv.includes("--help") || argv.includes("-h")
  };
}

function printHelp() {
  console.log(
    [
      "Usage: node scripts/build-binary.mjs [options]",
      "",
      "Build pipeline:",
      "  1) bundle src/index.js into one CJS file via esbuild",
      "  2) generate SEA blob via node --experimental-sea-config",
      "  3) inject blob into a copied node runtime via postject",
      "",
      "Options:",
      "  --clean     Remove dist and temporary build artifacts before building",
      "  -h, --help  Show help"
    ].join("\n")
  );
}

function binaryOutputPath() {
  const ext = process.platform === "win32" ? ".exe" : "";
  const filename = `clawty-${process.platform}-${process.arch}${ext}`;
  return path.join(DIST_ROOT, filename);
}

function launcherOutputPath() {
  return path.join(DIST_ROOT, "clawty");
}

function resolveLocalBin(name) {
  const ext = process.platform === "win32" ? ".cmd" : "";
  const candidate = path.join(process.cwd(), "node_modules", ".bin", `${name}${ext}`);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return name;
}

function runCommand(command, args, options = {}) {
  const stdio = options.stdio || "inherit";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      stdio,
      env: options.env || process.env
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function commandExists(command, args = ["--version"]) {
  try {
    await runCommand(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function ensureRequiredTools() {
  const esbuildCmd = resolveLocalBin("esbuild");
  const postjectCmd = resolveLocalBin("postject");
  const hasEsbuild = await commandExists(esbuildCmd);
  const hasPostject = await commandExists(postjectCmd, ["--help"]);

  const missing = [];
  if (!hasEsbuild) {
    missing.push("esbuild");
  }
  if (!hasPostject) {
    missing.push("postject");
  }

  if (missing.length > 0) {
    throw new Error(
      [
        `Missing required build tool(s): ${missing.join(", ")}`,
        "Install once with:",
        "  npm i -D esbuild postject"
      ].join("\n")
    );
  }

  return {
    esbuildCmd,
    postjectCmd
  };
}

function validatePlatform() {
  if (process.platform === "darwin" || process.platform === "linux") {
    return;
  }
  throw new Error(
    `Unsupported platform for current build script: ${process.platform}. ` +
      "Supported: darwin, linux."
  );
}

async function prepareDirectories(clean) {
  if (clean) {
    await fsp.rm(BUILD_ROOT, { recursive: true, force: true });
    await fsp.rm(DIST_ROOT, { recursive: true, force: true });
  }
  await fsp.mkdir(BUILD_ROOT, { recursive: true });
  await fsp.mkdir(DIST_ROOT, { recursive: true });
}

async function buildBundle(esbuildCmd) {
  await runCommand(esbuildCmd, [
    "src/index.js",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node24",
    "--external:tree-sitter",
    "--external:tree-sitter-*",
    `--outfile=${BUNDLE_PATH}`
  ]);
}

async function writeSeaConfig() {
  const config = {
    main: BUNDLE_PATH,
    output: SEA_BLOB_PATH,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
  };
  await fsp.writeFile(SEA_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function buildSeaBlob() {
  await runCommand(process.execPath, [`--experimental-sea-config=${SEA_CONFIG_PATH}`]);
}

async function injectBlob(postjectCmd, outputBinaryPath) {
  const args = [
    outputBinaryPath,
    "NODE_SEA_BLOB",
    SEA_BLOB_PATH,
    "--sentinel-fuse",
    SEA_SENTINEL,
    "--overwrite"
  ];
  if (process.platform === "darwin") {
    args.push("--macho-segment-name", "NODE_SEA");
  }
  await runCommand(postjectCmd, args);
}

async function maybeCodesign(outputBinaryPath) {
  if (process.platform !== "darwin") {
    return;
  }
  const hasCodesign = await commandExists("codesign", ["--version"]);
  if (!hasCodesign) {
    return;
  }
  await runCommand("codesign", ["--sign", "-", "--force", outputBinaryPath]);
}

async function writeUnixLauncher(outputBinaryPath) {
  const launcherPath = launcherOutputPath();
  const binaryName = path.basename(outputBinaryPath);
  const content = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'DIR="$(cd -- "$(dirname -- "$0")" && pwd)"',
    'export NODE_NO_WARNINGS="${NODE_NO_WARNINGS:-1}"',
    `exec "$DIR/${binaryName}" "$@"`,
    ""
  ].join("\n");
  await fsp.writeFile(launcherPath, content, "utf8");
  await fsp.chmod(launcherPath, 0o755);
  return launcherPath;
}

async function buildBinary() {
  validatePlatform();
  const { esbuildCmd, postjectCmd } = await ensureRequiredTools();
  const outputBinaryPath = binaryOutputPath();

  await buildBundle(esbuildCmd);
  await writeSeaConfig();
  await buildSeaBlob();
  await fsp.copyFile(process.execPath, outputBinaryPath);
  await fsp.chmod(outputBinaryPath, 0o755);
  await injectBlob(postjectCmd, outputBinaryPath);
  await maybeCodesign(outputBinaryPath);
  const launcherPath = await writeUnixLauncher(outputBinaryPath);

  console.log(`Binary build complete: ${outputBinaryPath}`);
  console.log(`Launcher created: ${launcherPath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  await prepareDirectories(args.clean);
  await buildBinary();
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
