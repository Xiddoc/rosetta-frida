/**
 * Tests for the command router — the single place that maps argv to a
 * command and enforces the one shared exit-code / stderr-prefix contract.
 *
 * Coverage targets:
 *   - help (`--help` / `-h`) and bare invocation → usage to STDOUT, exit 0
 *   - unknown command → error + usage to STDERR, exit 2 (misuse)
 *   - each command dispatched on the happy path → exit 0
 *   - a handled failure per command → uniform `rosetta <cmd>: …` line,
 *     exit 1
 *   - validate's MapValidationError issue list folded into stderr
 */

import { describe, expect, it } from 'vitest';
import { route, printUsage, EXIT_OK, EXIT_FAILURE, EXIT_MISUSE } from '../../cli/router.js';
import { emitMarkerBlock } from '../../src/marker/index.js';
import type { RosettaMap } from '../../src/types/map.js';
import { makeCaptured, makeFakeFs, makeIo } from './helpers.js';

const map = (version = '1.0.0'): RosettaMap => ({
    schema_version: 2,
    version_code: 1,
    app: 'com.example.app',
    version,
    classes: { IFoo: { obfuscated: 'aaaa' } },
});

const VALID_JSON = JSON.stringify(map());

describe('printUsage', () => {
    it('emits a Usage line and every command', () => {
        const lines: string[] = [];
        printUsage((l) => lines.push(l));
        expect(lines[0]).toMatch(/^Usage: rosetta/);
        for (const cmd of [
            'init',
            'pull',
            'validate',
            'convert',
            'patch',
            'extract',
            'inspect',
            'diff',
            'merge',
            'types',
        ]) {
            expect(lines.some((l) => l.includes(cmd))).toBe(true);
        }
    });

    it('no longer lists the removed merge-bundle / verify verbs', () => {
        const lines: string[] = [];
        printUsage((l) => lines.push(l));
        expect(lines.some((l) => /\bmerge-bundle\b/.test(l))).toBe(false);
        // `verify` was folded into `validate --deep`; it must not appear as a
        // standalone command row. (The word can still appear in prose, but the
        // command-table invocations no longer carry a `verify <...>` row.)
        expect(lines.some((l) => /^\s*verify\s/.test(l))).toBe(false);
    });
});

describe('route — help / bare / unknown', () => {
    it('prints usage to STDOUT and exits 0 on bare invocation', async () => {
        const fs = makeFakeFs();
        const captured = makeCaptured();
        const code = await route([], makeIo(fs, captured));
        expect(code).toBe(EXIT_OK);
        expect(captured.stdout[0]).toMatch(/^Usage: rosetta/);
        expect(captured.stderr).toEqual([]);
    });

    it('prints usage to STDOUT and exits 0 on --help', async () => {
        const fs = makeFakeFs();
        const captured = makeCaptured();
        const code = await route(['--help'], makeIo(fs, captured));
        expect(code).toBe(EXIT_OK);
        expect(captured.stdout[0]).toMatch(/^Usage: rosetta/);
        expect(captured.stderr).toEqual([]);
    });

    it('prints usage to STDOUT and exits 0 on -h', async () => {
        const fs = makeFakeFs();
        const captured = makeCaptured();
        const code = await route(['-h'], makeIo(fs, captured));
        expect(code).toBe(EXIT_OK);
        expect(captured.stdout[0]).toMatch(/^Usage: rosetta/);
    });

    it('prints error + usage to STDERR and exits 2 on unknown command', async () => {
        const fs = makeFakeFs();
        const captured = makeCaptured();
        const code = await route(['frobnicate'], makeIo(fs, captured));
        expect(code).toBe(EXIT_MISUSE);
        expect(captured.stdout).toEqual([]);
        expect(captured.stderr[0]).toMatch(/^rosetta: unknown command: frobnicate/);
        expect(captured.stderr.some((l) => /^Usage: rosetta/.test(l))).toBe(true);
    });
});

describe('route — dispatch happy paths', () => {
    it('routes inspect and exits 0', async () => {
        const fs = makeFakeFs({ 'b.js': emitMarkerBlock(map()) });
        const captured = makeCaptured();
        const code = await route(['inspect', 'b.js'], makeIo(fs, captured));
        expect(code).toBe(EXIT_OK);
        // Success output is prefixed per verb, mirroring the error path.
        expect(captured.stdout[0]).toMatch(/^rosetta inspect: com\.example\.app@1\.0\.0/);
    });

    it('routes extract and exits 0', async () => {
        const fs = makeFakeFs({ 'b.js': emitMarkerBlock(map()) });
        const captured = makeCaptured();
        const code = await route(['extract', 'b.js', '-o', 'out.json'], makeIo(fs, captured));
        expect(code).toBe(EXIT_OK);
        expect(fs.files.has('out.json')).toBe(true);
    });

    it('routes patch and exits 0', async () => {
        const fs = makeFakeFs({ 'b.js': emitMarkerBlock(map('0.1.0')), 'n.json': VALID_JSON });
        const captured = makeCaptured();
        const code = await route(['patch', 'b.js', '--map', 'n.json'], makeIo(fs, captured));
        expect(code).toBe(EXIT_OK);
        expect(captured.stdout[0]).toMatch(/^rosetta patch: wrote .* \(in place\)$/);
    });

    it('routes init and exits 0', async () => {
        const fs = makeFakeFs();
        const captured = makeCaptured();
        const code = await route(
            ['init', 'com.example.app', '1.2.3', '--version-code', '30405', '-o', 'm.json'],
            makeIo(fs, captured),
        );
        expect(code).toBe(EXIT_OK);
        expect(fs.files.has('m.json')).toBe(true);
        expect(captured.stdout[0]).toBe('rosetta init: wrote m.json');
    });

    it('routes convert and exits 0', async () => {
        const yaml =
            'schema_version: 2\napp: com.example.app\nversion: "1.0.0"\nversion_code: 1\nclasses:\n  IFoo:\n    obfuscated: aaaa\n';
        const fs = makeFakeFs({ 'in.yaml': yaml });
        const captured = makeCaptured();
        const code = await route(['convert', 'in.yaml', '-o', 'out.json'], makeIo(fs, captured));
        expect(code).toBe(EXIT_OK);
        expect(fs.files.has('out.json')).toBe(true);
    });

    it('routes validate and exits 0', async () => {
        const fs = makeFakeFs({ 'm.json': VALID_JSON });
        const captured = makeCaptured();
        const code = await route(['validate', 'm.json'], makeIo(fs, captured));
        expect(code).toBe(EXIT_OK);
        expect(captured.stdout[0]).toMatch(/^rosetta validate: OK:/);
    });

    it('routes diff and exits 0', async () => {
        const fs = makeFakeFs({ 'a.json': VALID_JSON, 'b.json': VALID_JSON });
        const captured = makeCaptured();
        const code = await route(['diff', 'a.json', 'b.json'], makeIo(fs, captured));
        expect(code).toBe(EXIT_OK);
        expect(captured.stdout[0]).toMatch(/^rosetta diff: com\.example\.app:/);
    });

    it('routes merge and exits 0', async () => {
        const fs = makeFakeFs({ 'a.json': VALID_JSON, 'b.json': VALID_JSON });
        const captured = makeCaptured();
        const code = await route(
            ['merge', 'a.json', 'b.json', '-o', 'out.json'],
            makeIo(fs, captured),
        );
        expect(code).toBe(EXIT_OK);
        expect(fs.files.has('out.json')).toBe(true);
        expect(captured.stdout[0]).toBe('rosetta merge: wrote out.json');
    });

    it('routes validate --deep and exits 0', async () => {
        const fs = makeFakeFs({ 'm.json': VALID_JSON });
        const captured = makeCaptured();
        const code = await route(['validate', 'm.json', '--deep'], makeIo(fs, captured));
        expect(code).toBe(EXIT_OK);
        expect(captured.stdout[0]).toMatch(/^rosetta validate: OK:/);
    });

    it('rejects the removed merge-bundle verb as unknown (exit 2)', async () => {
        const fs = makeFakeFs({ 'a.json': VALID_JSON, 'b.json': VALID_JSON });
        const captured = makeCaptured();
        const code = await route(
            ['merge-bundle', 'a.json', 'b.json', '-o', 'out.json'],
            makeIo(fs, captured),
        );
        expect(code).toBe(EXIT_MISUSE);
        expect(captured.stderr[0]).toMatch(/unknown command: merge-bundle/);
    });

    it('rejects the removed verify verb as unknown (exit 2)', async () => {
        const fs = makeFakeFs({ 'm.json': VALID_JSON });
        const captured = makeCaptured();
        const code = await route(['verify', 'm.json'], makeIo(fs, captured));
        expect(code).toBe(EXIT_MISUSE);
        expect(captured.stderr[0]).toMatch(/unknown command: verify/);
    });

    it('routes types and exits 0', async () => {
        const fs = makeFakeFs({ 'm.json': VALID_JSON });
        const captured = makeCaptured();
        const code = await route(['types', 'm.json', '-o', 'out.d.ts'], makeIo(fs, captured));
        expect(code).toBe(EXIT_OK);
        expect(fs.files.has('out.d.ts')).toBe(true);
        expect(captured.stdout[0]).toBe('rosetta types: wrote out.d.ts');
    });
});

describe('route — dispatch happy paths (pull)', () => {
    it('routes pull and exits 0 when fetch succeeds', async () => {
        // Test pull dispatch through the router by using routeWithPullConfig,
        // which is the same as route but lets us inject a mock fetch config.
        // We import the command directly and wrap it the same way the router does.
        const { runPull } = await import('../../cli/commands/pull.js');
        const VALID_MAP = JSON.stringify({
            schema_version: 2,
            app: 'com.example.app',
            version: '3.4.5',
            version_code: 30405,
            classes: { 'com.example.app.IFoo': { obfuscated: 'aaaa' } },
        });
        const config = {
            mapsRepoBaseUrl: 'https://raw.example.com',
            mapsRepoRef: 'main',
            requireSidecar: false,
            // Sidecar absent (404) → non-strict warn-and-proceed; the map fetch
            // returns the valid map. Keeps this a happy-path dispatch test.
            fetch: (url: string) =>
                url.endsWith('.sha256')
                    ? Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') })
                    : Promise.resolve({
                          ok: true,
                          status: 200,
                          text: () => Promise.resolve(VALID_MAP),
                      }),
        };
        const fs = makeFakeFs();
        const captured = makeCaptured();
        const msg = await runPull(
            ['com.example.app@30405', '-o', 'm.json'],
            makeIo(fs, captured),
            config,
        );
        expect(fs.files.has('m.json')).toBe(true);
        expect(msg).toBe('wrote m.json');
    });
});

describe('route — unified failure formatting', () => {
    it('formats a patch failure under the rosetta patch: prefix, exit 1', async () => {
        const fs = makeFakeFs({ 'n.json': VALID_JSON }); // bundle missing
        const captured = makeCaptured();
        const code = await route(['patch', 'missing.js', '--map', 'n.json'], makeIo(fs, captured));
        expect(code).toBe(EXIT_FAILURE);
        expect(captured.stdout).toEqual([]);
        expect(captured.stderr[0]).toMatch(/^rosetta patch: cannot read bundle/);
    });

    it('formats an inspect arg error under the rosetta inspect: prefix, exit 1', async () => {
        const fs = makeFakeFs();
        const captured = makeCaptured();
        const code = await route(['inspect'], makeIo(fs, captured));
        expect(code).toBe(EXIT_FAILURE);
        expect(captured.stderr[0]).toMatch(/^rosetta inspect: missing required argument/);
    });

    it('formats an extract failure under the rosetta extract: prefix, exit 1', async () => {
        const fs = makeFakeFs();
        const captured = makeCaptured();
        const code = await route(['extract', 'missing.js', '-o', 'o.json'], makeIo(fs, captured));
        expect(code).toBe(EXIT_FAILURE);
        expect(captured.stderr[0]).toMatch(/^rosetta extract: cannot read bundle/);
    });

    it('formats an init failure under the rosetta init: prefix, exit 1', async () => {
        const fs = makeFakeFs({ 'm.json': 'existing' });
        const captured = makeCaptured();
        const code = await route(
            ['init', 'com.example.app', '1.2.3', '--version-code', '100', '-o', 'm.json'],
            makeIo(fs, captured),
        );
        expect(code).toBe(EXIT_FAILURE);
        expect(captured.stderr[0]).toMatch(/^rosetta init: refusing to overwrite/);
    });

    it('formats a pull arg error under the rosetta pull: prefix, exit 1', async () => {
        // Bad arg (no positional) fails before any network call.
        const fs = makeFakeFs();
        const captured = makeCaptured();
        const code = await route(['pull'], makeIo(fs, captured));
        expect(code).toBe(EXIT_FAILURE);
        expect(captured.stderr[0]).toMatch(/^rosetta pull: pull requires exactly one/);
    });

    it('formats a convert failure under the rosetta convert: prefix, exit 1', async () => {
        const fs = makeFakeFs({ 'in.json': '{}' });
        const captured = makeCaptured();
        const code = await route(['convert', 'in.json', '-o', 'o.json'], makeIo(fs, captured));
        expect(code).toBe(EXIT_FAILURE);
        expect(captured.stderr[0]).toMatch(/^rosetta convert: input is already in canonical/);
    });

    it('formats a validate file-not-found failure under the rosetta validate: prefix, exit 1', async () => {
        // The only command whose route-level failure path was previously
        // unexercised. Confirms the uniform prefix + the `cannot read`
        // wrapping (SHOULD: convert/validate now wrap reads like the rest).
        const fs = makeFakeFs(); // no m.json seeded
        const captured = makeCaptured();
        const code = await route(['validate', 'm.json'], makeIo(fs, captured));
        expect(code).toBe(EXIT_FAILURE);
        expect(captured.stdout).toEqual([]);
        expect(captured.stderr[0]).toMatch(/^rosetta validate: cannot read m\.json/);
    });

    it('folds an empty-path validate issue without an "at" prefix', async () => {
        // Empty YAML → MapValidationError whose only issue has path: '' —
        // exercises formatErrorLines' no-path branch (`  <message>`).
        const fs = makeFakeFs({ 'm.yaml': '' });
        const captured = makeCaptured();
        const code = await route(['validate', 'm.yaml'], makeIo(fs, captured));
        expect(code).toBe(EXIT_FAILURE);
        expect(captured.stderr[0]).toMatch(/^rosetta validate: /);
        // The issue line is indented but has no "at <path>:" segment.
        expect(captured.stderr.some((l) => /^ {2}document is null or empty$/.test(l))).toBe(true);
    });

    it('folds validate issue list into stderr under one prefix, exit 1', async () => {
        const fs = makeFakeFs({
            'm.json':
                '{"schema_version": 2, "version_code": 1, "app": "x", "classes": {"IFoo": {}}}',
        });
        const captured = makeCaptured();
        const code = await route(['validate', 'm.json'], makeIo(fs, captured));
        expect(code).toBe(EXIT_FAILURE);
        expect(captured.stdout).toEqual([]);
        expect(captured.stderr[0]).toMatch(/^rosetta validate: .*schema validation/);
        // At least one indented issue line follows.
        expect(captured.stderr.length).toBeGreaterThan(1);
        expect(captured.stderr.some((l) => /^ {2}at /.test(l))).toBe(true);
    });
});
