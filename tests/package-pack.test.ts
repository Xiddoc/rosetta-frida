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
 * self-contained on a fresh checkout (where `dist/` is git-ignored).
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

/** Manifest fields whose values are paths the tarball MUST contain. */
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    main: string;
    module: string;
    types: string;
    bin: Record<string, string>;
    exports: Record<string, { types: string; import: string } | string>;
};

/** Strip a leading `./` so a manifest path matches an `npm pack` entry path. */
function rel(p: string): string {
    return p.replace(/^\.\//, '');
}

let packedPaths: Set<string>;

beforeAll(() => {
    // Self-contained on a fresh checkout: build the dist the manifest points
    // at if it isn't there yet (dist/ is git-ignored).
    if (!existsSync(path.join(repoRoot, rel(pkg.main)))) {
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
        const required = [
            rel(pkg.main),
            rel(pkg.module),
            rel(pkg.types),
            ...Object.values(pkg.bin).map(rel),
        ];
        for (const target of required) {
            expect(packedPaths.has(target), `tarball must include ${target}`).toBe(true);
        }
    });

    it('includes every file referenced by the exports map', () => {
        for (const entry of Object.values(pkg.exports)) {
            const targets = typeof entry === 'string' ? [entry] : [entry.types, entry.import];
            for (const target of targets) {
                // package.json is referenced by `./package.json` and always present.
                expect(
                    packedPaths.has(rel(target)),
                    `tarball must include exports target ${target}`,
                ).toBe(true);
            }
        }
    });

    it('excludes TypeScript source, the test suite, and tooling configs', () => {
        const forbidden = [...packedPaths].filter(
            (p) =>
                p.startsWith('src/') ||
                p.startsWith('tests/') ||
                /\.test\.(ts|js)$/.test(p) ||
                p === 'tsconfig.json' ||
                p === 'tsconfig.test.json' ||
                p === 'vitest.config.ts' ||
                p === 'eslint.config.js',
        );
        expect(
            forbidden,
            `unexpected source/test/config files in tarball: ${forbidden.join(', ')}`,
        ).toEqual([]);
    });

    it('ships only built output under dist/ (no stray .ts source in dist)', () => {
        const tsInDist = [...packedPaths].filter(
            (p) => p.startsWith('dist/') && p.endsWith('.ts') && !p.endsWith('.d.ts'),
        );
        expect(tsInDist).toEqual([]);
    });
});
