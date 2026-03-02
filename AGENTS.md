# Repository Guidelines

## Project Structure & Module Organization
This repository is a Node.js ESM CLI project.

- `src/index.js`: CLI entrypoint (`chat`, `run`, `--help`)
- `src/agent.js`: agent loop and tool-calling orchestration
- `src/tools.js`: local tool implementations (`read_file`, `write_file`, `run_shell`)
- `src/openai.js`: OpenAI Responses API client
- `src/config.js`: `.env` loading and runtime config
- `README.md`: usage documentation
- `.env.example`: required environment variable template

Keep new runtime modules in `src/`. If tests are added, place them in `tests/`.

## Build, Test, and Development Commands
- `node src/index.js --help`: show CLI usage and env requirements.
- `node src/index.js chat`: start interactive multi-turn mode.
- `node src/index.js run "your task"`: execute a single task.
- `npm run start`: alias for `node src/index.js`.
- `npm run chat` / `npm run run -- "task"`: npm-script variants.

There is no separate build step yet (plain JavaScript runtime).

## Coding Style & Naming Conventions
- Use modern JavaScript (ESM) with explicit `import`/`export`.
- Indentation: 2 spaces; keep semicolons enabled.
- Naming: `camelCase` for functions/variables, `UPPER_SNAKE_CASE` for constants, lowercase filenames in `src/`.
- Prefer small, single-purpose modules and early error handling.
- Keep comments minimal and only for non-obvious logic.

## Testing Guidelines
Automated tests are not set up yet. Until then, run smoke checks:

1. `node src/index.js --help`
2. `node src/index.js chat`
3. `node src/index.js run "read README.md and summarize"`

When adding tests, use Node’s built-in test runner with files named `*.test.js` under `tests/`.

## Commit & Pull Request Guidelines
No project Git history is available yet; follow Conventional Commits going forward:
- `feat: add patch-based file editing tool`
- `fix: handle network error in openai client`

PRs should include:
- clear summary of behavior changes
- commands used for verification
- config or security impact (if any)

## Security & Configuration Tips
- Never commit secrets; keep `OPENAI_API_KEY` only in `.env`.
- Respect workspace sandboxing (`CLAWTY_WORKSPACE_ROOT`).
- Avoid introducing unsafe shell execution paths or bypassing blocked-command rules.
