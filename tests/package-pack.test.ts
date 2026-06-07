/**
 * Publish-tarball guard (M15).
 *
 * The package is distributed on npm as a tarball whose contents are governed
 * by the `files` allowlist + `.npmignore`/`.gitignore` defaults. A broken
 * allowlist can silently ship the wrong thing two ways:
 *
 *   - ship TOO LITTLE — the built entrypoint (`dist/src/index.js`) or its
 *     type declarations missing, so `import 'rosetta-frida'` resolves to
 *     nothing and every consumer build breaks; or
 *   - ship TOO MUCH — TypeScript SOURCE (`src/`), the TEST suite, or tooling
 *     configs leaking into the published package, bloating it and exposing
 *     internals the package never meant to publish.
 *
 * This test pins both directions by asking npm what it *would* pack
 * (`npm pack --dry-run --json`, which performs no network I/O and writes no
 * tarball) and asserting on the resulting file list. It is wired into the
 * normal test run (and thus `npm run verify`), so CI fails fast on a
 * packaging regression rather than discovering it at publish time. The
 * package.json `exports`/`main`/`types`/`bin` targets are asserted to be
 * present in that list, so the manifest can never point at a path the
 * tarball doesn't carry.
 *
 * The check builds `dist/` first when the entrypoint is absent, so it is
 * self-contained on a fresh checkout (where `dist/` is git-ignored). Under
 * CI (`process.env.CI`) it ALWAYS rebuilds, so CI never validates a stale
 * `dist/` left over from a previous step.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface PackEntry {
    path: string;
}
interface PackResult {
    files: PackEntry[];
}

/**
 * A single `exports` condition map. Conditions are open-ended (`types`,
 * `import`, `require`, `default`, …); we treat every string-valued condition
 * as a path the tarball must carry, so adding a `require`/`default` branch
 * later is covered automatically rather than silently unchecked.
 */
type ExportConditions = Record<string, string>;

/** Manifest fields whose values are paths the tarball MUST contain. */
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    main: string;
    types: string;
    bin: Record<string, string>;
    exports: Record<string, ExportConditions | string>;
};

/** Strip a leading `./` so a manifest path matches an `npm pack` entry path. */
function rel(p: string): string {
    return p.replace(/^\.\//, '');
}

/**
 * Collect every path an `exports` entry resolves to, robust to all known
 * shapes: a bare string (`"./package.json"`) or a condition map with any mix
 * of `types`/`import`/`require`/`default`/… string-valued conditions. Nested
 * condition maps are flattened recursively. Returns the raw (un-`rel`'d)
 * paths.
 */
function exportTargets(entry: ExportConditions | string): string[] {
    if (typeof entry === 'string') {
        return [entry];
    }
    const out: string[] = [];
    for (const value of Object.values(entry)) {
        if (typeof value === 'string') {
            out.push(value);
        } else if (value !== null && typeof value === 'object') {
            out.push(...exportTargets(value));
        }
    }
    return out;
}

let packedPaths: Set<string>;

beforeAll(() => {
    // Self-contained on a fresh checkout: build the dist the manifest points
    // at if it isn't there yet (dist/ is git-ignored). Under CI always
    // rebuild so a stale dist/ from a prior step is never validated.
    if (process.env.CI || !existsSync(path.join(repoRoot, rel(pkg.main)))) {
        execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
    }
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
    const result = JSON.parse(raw) as PackResult[];
    packedPaths = new Set(result[0]?.files.map((f) => f.path) ?? []);
}, 120_000);

describe('publish tarball (npm pack --dry-run)', () => {
    it('includes the built entrypoint, types, and CLI bin the manifest points at', () => {
        const required = [rel(pkg.main), rel(pkg.types), ...Object.values(pkg.bin).map(rel)];
        for (const target of required) {
            expect(packedPaths.has(target), `tarball must include ${target}`).toBe(true);
        }
    });

    it('includes every file referenced by the exports map', () => {
        for (const entry of Object.values(pkg.exports)) {
            for (const target of exportTargets(entry)) {
                expect(
                    packedPaths.has(rel(target)),
                    `tarball must include exports target ${target}`,
                ).toBe(true);
            }
        }
    });

    it('contains ONLY the allowlisted top-level entries (dist, maps, README, LICENSE, package.json)', () => {
        // Tighten the exclusion to a positive ALLOWLIST: every packed path must
        // be under one of the `files` allowlist dirs, the always-present
        // `package.json` (npm injects it regardless of `files`), or a top-level
        // README/LICENSE. A future `files` edit that adds e.g. `scripts/` or
        // `docs/` — or a stray `src/`, test, or tooling config leaking in —
        // fails here instead of shipping silently.
        const allowedRoots = ['dist/', 'maps/'];
        const allowedExact = ['package.json', 'README.md', 'LICENSE'];
        const unexpected = [...packedPaths].filter(
            (p) => !allowedRoots.some((root) => p.startsWith(root)) && !allowedExact.includes(p),
        );
        expect(
            unexpected,
            `unexpected files in tarball (not under the allowlist): ${unexpected.join(', ')}`,
        ).toEqual([]);
    });

    it('ships only built output under dist/ (no stray .ts source in dist)', () => {
        const tsInDist = [...packedPaths].filter(
            (p) => p.startsWith('dist/') && p.endsWith('.ts') && !p.endsWith('.d.ts'),
        );
        expect(tsInDist).toEqual([]);
    });
});
