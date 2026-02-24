# CLAUDE.md - Development Guide

This project (`claude-spend`) is a Node.js/TypeScript CLI tool that launches an Express dashboard server. It has two distinct layers: the **CLI entry point** (`src/index.ts`) and the **backend server** (`src/server.ts`, `src/parser.ts`).

## Dynamic Rule Activation

Rules live in `.cursor/rules/`. **Do not load all rules at once.** Read and apply them contextually based on what you are working on, using the activation table below. When a task spans multiple domains, combine the relevant rule sets.

### Always Active (Shared)

These rules apply to **every** task. Read them at the start of any session.

| File | Governs |
|------|---------|
| `.cursor/rules/core-principles.mdc` | Honesty, simplicity, testing requirements |
| `.cursor/rules/code-quality.mdc` | SOLID, DRY, clean code patterns |
| `.cursor/rules/security-fundamentals.mdc` | Zero trust, input validation, secrets |
| `.cursor/rules/git-workflow.mdc` | Commits, branches, PRs, safety |
| `.cursor/rules/communication.mdc` | Direct, objective, professional |

### Contextual Rule Sets

Determine which set(s) to activate by matching the task to the trigger conditions. If a task touches multiple areas, load all matching sets.

#### `javascript-expert` — TypeScript & Node.js fundamentals

**Activate when:** editing any `.ts`/`.js` file, configuring `tsconfig.json`, working with types, optimizing runtime performance, or reviewing JS/TS patterns.

| File | Governs |
|------|---------|
| `.cursor/rules/javascript-expert-overview.mdc` | General JS/TS engineering posture |
| `.cursor/rules/javascript-expert-language-deep-dive.mdc` | Language semantics, closures, prototypes, async |
| `.cursor/rules/javascript-expert-typescript-deep-dive.mdc` | Type system, generics, utility types, strict mode |
| `.cursor/rules/javascript-expert-node-patterns.mdc` | Node.js idioms, streams, event loop, modules |
| `.cursor/rules/javascript-expert-performance.mdc` | V8 optimization, memory, profiling |
| `.cursor/rules/javascript-expert-react-patterns.mdc` | React components, hooks, state (if frontend added) |
| `.cursor/rules/javascript-expert-testing.mdc` | JS/TS-specific test patterns |
| `.cursor/rules/javascript-expert-tooling.mdc` | Build tools, linters, bundlers |

#### `cli-tools` — CLI entry point & UX

**Activate when:** working on `src/index.ts` (the CLI entry), argument parsing, `--help` output, `bin` configuration in `package.json`, process signals, exit codes, or terminal output formatting.

| File | Governs |
|------|---------|
| `.cursor/rules/cli-tools-overview.mdc` | CLI design philosophy |
| `.cursor/rules/cli-tools-architecture.mdc` | Command structure, subcommands, composition |
| `.cursor/rules/cli-tools-arguments.mdc` | Flags, options, positional args, validation |
| `.cursor/rules/cli-tools-error-handling.mdc` | Exit codes, stderr, graceful failures |
| `.cursor/rules/cli-tools-user-experience.mdc` | Output formatting, colors, progress, prompts |
| `.cursor/rules/cli-tools-testing.mdc` | CLI-specific test strategies |
| `.cursor/rules/cli-tools-distribution.mdc` | npm publishing, `bin`, `npx`, packaging |

#### `web-backend` — Express server, API, data

**Activate when:** working on `src/server.ts`, `src/parser.ts`, route handlers, middleware, request/response handling, API endpoints, data access, or authentication.

| File | Governs |
|------|---------|
| `.cursor/rules/web-backend-overview.mdc` | Backend architecture posture |
| `.cursor/rules/web-backend-api-design.mdc` | REST conventions, endpoint design, status codes |
| `.cursor/rules/web-backend-error-handling.mdc` | Error middleware, structured error responses |
| `.cursor/rules/web-backend-security.mdc` | CORS, rate limiting, header hardening |
| `.cursor/rules/web-backend-authentication.mdc` | Auth flows, sessions, tokens |
| `.cursor/rules/web-backend-database-patterns.mdc` | Data access, queries, migrations |
| `.cursor/rules/web-backend-testing.mdc` | API/integration test patterns |

#### `testing` — Writing or reviewing tests

**Activate when:** creating tests, running test suites, setting up test infrastructure, debugging test failures, or evaluating coverage.

| File | Governs |
|------|---------|
| `.cursor/rules/testing-overview.mdc` | Testing philosophy and strategy |
| `.cursor/rules/testing-tdd-methodology.mdc` | Red-green-refactor, test-first workflow |
| `.cursor/rules/testing-test-design.mdc` | Arrange-act-assert, naming, isolation |
| `.cursor/rules/testing-test-types.mdc` | Unit, integration, e2e classification |
| `.cursor/rules/testing-test-data.mdc` | Fixtures, factories, mocks, stubs |
| `.cursor/rules/testing-advanced-techniques.mdc` | Property-based, snapshot, mutation testing |
| `.cursor/rules/testing-reliability.mdc` | Flaky test prevention, determinism |
| `.cursor/rules/testing-performance-testing.mdc` | Load testing, benchmarks |
| `.cursor/rules/testing-quality-metrics.mdc` | Coverage targets, quality signals |
| `.cursor/rules/testing-ci-cd-integration.mdc` | CI pipelines, test gating |

#### `qa-engineering` — Quality strategy & process

**Activate when:** defining quality gates, planning test strategy across the project, setting up automation pipelines, or evaluating release readiness.

| File | Governs |
|------|---------|
| `.cursor/rules/qa-engineering-overview.mdc` | QA program philosophy |
| `.cursor/rules/qa-engineering-test-strategy.mdc` | Risk-based test planning |
| `.cursor/rules/qa-engineering-test-design.mdc` | Boundary analysis, equivalence partitioning |
| `.cursor/rules/qa-engineering-automation.mdc` | Automation pyramid, framework selection |
| `.cursor/rules/qa-engineering-quality-gates.mdc` | Definition of done, release criteria |
| `.cursor/rules/qa-engineering-metrics.mdc` | Defect density, MTTR, quality KPIs |

## Activation Decision Process

When starting any task, follow this sequence:

1. **Read the shared rules** (always).
2. **Classify the task** by asking: what files will I touch and what kind of work is this?
3. **Load matching contextual sets** by reading the relevant `.mdc` files before writing code.
4. **If the task spans multiple domains**, combine sets. For example: adding a new CLI flag that also adds an API endpoint → load `cli-tools` + `web-backend` + `javascript-expert`.
5. **When writing or modifying tests**, always load `testing` alongside the domain set for the code under test.

### Quick Reference — File-to-Ruleset Mapping

| Files / Areas | Rule Sets to Activate |
|---|---|
| `src/index.ts`, CLI args, process handling | `javascript-expert` + `cli-tools` |
| `src/server.ts`, routes, middleware | `javascript-expert` + `web-backend` |
| `src/parser.ts`, data processing | `javascript-expert` + `web-backend` |
| `src/types.ts`, type definitions | `javascript-expert` |
| `src/public/`, HTML/CSS/frontend | `javascript-expert` |
| `tsconfig.json`, `package.json`, build config | `javascript-expert` + `cli-tools` (if bin-related) |
| `*.test.ts`, `*.spec.ts`, test setup | `testing` + domain set for code under test |
| CI config, quality gates, release process | `qa-engineering` + `testing` |

## Customization

- Create new `.mdc` files in `.cursor/rules/` for project-specific rules
- Edit existing files directly; changes take effect immediately
- Re-run to update: `npx @djm204/agent-skills cli-tools javascript-expert qa-engineering testing web-backend`
