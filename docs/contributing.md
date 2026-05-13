# Contributing

Short version: clone, `npm install`, `npm run verify`, send a PR.

## Setup

```sh
git clone https://github.com/rosetta-frida/rosetta-frida
cd rosetta-frida
npm install
```

Node 18.18 or newer required. The library has no native dependencies
on the build side — pure TypeScript + a couple of JS deps (`yaml`,
`zod`).

## The verify pipeline

```sh
npm run verify
```

Runs (in order):

1. `npm run typecheck` — `tsc --noEmit` against the strict
   `tsconfig.json`.
2. `npm run lint` — ESLint with the project's flat config.
3. `npm run format:check` — Prettier in check mode.
4. `npm run test:coverage` — Vitest with 100% coverage threshold.

All four must pass before a PR merges. Master is gated on this.

### Individual commands

| Command | What it does |
|---|---|
| `npm test` | Run the test suite once. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:coverage` | Tests + coverage report. Fails if coverage drops below 100% (lines, branches, functions, statements). |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit`. |
| `npm run lint` | ESLint. |
| `npm run lint:fix` | ESLint with `--fix`. |
| `npm run format` | Write Prettier formatting. |
| `npm run format:check` | Check Prettier formatting. |
| `npm run build` | `tsc -p tsconfig.json` (emits `dist/`). |
| `npm run cli -- <args>` | Run the CLI via `tsx` directly from `cli/index.ts`. |

## Repository layout

```text
rosetta-frida/
├── src/                       # Library runtime source
│   ├── api/                   # Tier 1/2/3 entry points + rosetta namespace
│   ├── convert/               # YAML / TS-module converters
│   ├── diagnostics/           # EventBus re-export
│   ├── marker/                # PEM-style marker block emit/parse/patch
│   ├── parse/                 # JSONC parser + loadMap
│   ├── proxy/                 # ClassProxy, MethodHandle, FieldAccessor
│   ├── resolver/              # Real → obf translation
│   ├── session/               # Session lifecycle, auto-detect, health check
│   ├── types/                 # Public type definitions (LOCKED contracts)
│   ├── validate/              # Zod schema
│   ├── errors.ts              # Error class hierarchy
│   ├── log.ts                 # EventBus + trace formatter
│   └── index.ts               # Public re-exports
├── cli/                       # CLI binary
│   ├── commands/              # One file per subcommand
│   └── index.ts               # Dispatcher
├── examples/sample-hook/      # Canonical example hook + test
├── maps/com.example.app/      # Sample map (15-class anonymized)
├── tests/                     # Cross-cutting integration tests
└── docs/                      # This documentation site
```

The `src/types/` directory is **locked contract** — those types are
the boundary between subsystems and between the library and its
consumers. Changes there cascade everywhere; treat them as a
deliberate API edit.

## Development model

V1.0 was implemented in four "waves" of mostly-independent parallel
subagent work, integrated linearly:

- **Wave 1A** — JSONC parser, schema validator.
- **Wave 1B** — Resolver, diagnostics, failure policies.
- **Wave 1C** — Marker block, CLI patch/extract/inspect.
- **Wave 1D** — Converters, CLI init/validate/convert, sample map.
- **Wave 2E** — Proxy layer, tier-2 `rosetta.use` / `rosetta.type`.
- **Wave 2F** — Tier-1 `rosetta.hook` / `proceed` / `field` /
  `setField`.
- **Wave 2G** — Session lifecycle, auto-detect, health check,
  tier-3 `rosetta.map.*` / `rosetta.events.*`.
- **Wave 3** — Canonical user-facing `rosetta` namespace; sample
  hook example.

Each wave landed as its own integration commit on `master`. The
parallel-agent model is documented in
[CLAUDE.md](https://github.com/rosetta-frida/rosetta-frida/blob/main/CLAUDE.md);
contributors are welcome to follow the same model for non-trivial
additions, but it's not required.

## Coding conventions

- **TypeScript everywhere.** No JS source files outside the CLI
  shim. Runtime is compiled to JS for Frida's sandbox.
- **`strict: true` plus `noUncheckedIndexedAccess`.** Index reads
  return `T | undefined`. Embrace the asserts.
- **No `any`.** Use `unknown` and narrow. The lint config flags
  `any`.
- **Errors extend `RosettaError`.** Always carry structured context
  (class field references, not message-string parsing).
- **Events for diagnostics.** Don't `console.log` from the library;
  emit an event. Trace mode is opt-in by the user.
- **Tests next to source.** `src/foo.ts` and `src/foo.test.ts` in
  the same directory. Vitest finds them.
- **100% coverage is real, not aspirational.** Every branch is
  exercised. New PRs must keep it at 100% — the verify pipeline
  enforces this.

## Writing tests

Vitest. The project uses the standard pattern:

```typescript
// src/api/hook.test.ts
import { describe, it, expect } from 'vitest';
import { hook } from './hook.js';
// ... etc ...
```

For tests that need a `Resolver`, the existing `tests/fixtures/`
folder has helpers — but most tests build a tiny in-test resolver
inline, which keeps each test self-contained.

For tests that need Frida's `Java.use`, **inject it via the options
parameter** rather than mocking `globalThis.Java`:

```typescript
const mockJava = { use: vi.fn(/* ... */) };
const proxy = makeClassProxy(resolver, 'Foo', { javaUse: mockJava.use });
```

Globals are last-resort. The wave-2E and wave-2G test suites are the
canonical examples of the injection pattern.

## CLI tests

CLI commands take a `CommandIo` (for bundle-manipulation commands) or
an optional `fsImpl` (for map-authoring commands). Both shapes are
tested with mock fs:

```typescript
const io: CommandIo = {
    fs: { readFile: vi.fn(/* ... */), writeFile: vi.fn() },
    stdout: vi.fn(),
    stderr: vi.fn(),
};
const code = await runInspect(['hook.bundle.js'], io);
expect(code).toBe(0);
```

This pattern lets every CLI command run as a unit test without
spawning subprocesses.

## Adding a new feature

1. **Identify the subsystem.** Resolver? Proxy? Diagnostics? A new
   API tier? Document where it lives before writing code.
2. **Update types first.** If the change touches a contract in
   `src/types/`, write the type change as a separate commit. Other
   files break; fix them in subsequent commits.
3. **Test-first when possible.** Vitest is fast; the loop is tight.
4. **Update docs.** This site, the CHANGELOG (V1.0 entry currently
   in `docs/changelog.md`), and any relevant references.
5. **Run `npm run verify` before pushing.** All four checks green.

## What we won't accept

Per the project's anti-scope list (see `CLAUDE.md`):

- **A deobfuscator.** Don't add APK analysis. Maps come *from*
  other tools (sigmatcher, jadx). This library *consumes* them.
- **A Frida wrapper for non-Java targets.** V1 is Java/Kotlin
  Android. Native (JNI / ELF) is a V2+ separate-shape concern.
- **A hook framework.** Frida defines what a hook is. This library
  makes `Java.use` smarter.
- **A sigmatcher replacement.** sigmatcher is one upstream input.

## Filing issues

When the library has a public issue tracker, please include:

- The error message (full text).
- A minimal reproducer if possible.
- The output of `rosetta inspect <bundle.js>` if it relates to the
  bundle pipeline.
- Trace output (`session({ trace: true })`) if it relates to the
  runtime.
- Library version, Node version, Frida version.

Maps containing real obfuscated names from real apps are also
welcome (V2 will ship a public maps repo for this) — but in the
issue tracker, please anonymize or redact.
