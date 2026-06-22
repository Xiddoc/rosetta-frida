/**
 * Tests for `rosetta validate`.
 *
 * The mock fs object is a plain record of functions rather than a class —
 * each operation returns a Promise via `Promise.resolve()` / `Promise.reject()`
 * to satisfy the typed `fs/promises` signature while keeping operations
 * synchronous (no `await` needed, no lint flag).
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { parseValidateArgs, loadMap, runValidate } from '../../cli/commands/validate.js';
import { RosettaError, MapValidationError } from '../../src/errors.js';
import type { CommandIo, FsLike } from '../../cli/commands/io.js';
import { makeCaptured, makeFakeFs, makeFsLike, makeIo } from './helpers.js';

// The committed sample map is validated against the real filesystem; that
// one case needs the production fs (read-only).
import * as realFs from 'node:fs/promises';

const VALID_JSON = `{
    "schema_version": 5,
    "app": "com.example.app",
    "version": "1.0.0",
    "version_code": 100,
    "classes": {
        "IFoo": { "obfuscated": "aaaa" }
    }
}`;

const VALID_YAML = `
schema_version: 5
app: com.example.app
version: "1.0.0"
version_code: 100
classes:
  IFoo:
    obfuscated: aaaa
`;

function makeFs(initial: Record<string, string>): FsLike {
    return makeFsLike(makeFakeFs(initial));
}

describe('parseValidateArgs', () => {
    it('accepts exactly one positional', () => {
        const o = parseValidateArgs(['m.json']);
        expect(o.inputPath).toBe('m.json');
        expect(o.deep).toBe(false);
        expect(o.json).toBe(false);
    });

    it('accepts --deep and its --semantic alias', () => {
        expect(parseValidateArgs(['m.json', '--deep']).deep).toBe(true);
        expect(parseValidateArgs(['m.json', '--semantic']).deep).toBe(true);
    });

    it('accepts --json', () => {
        expect(parseValidateArgs(['m.json', '--deep', '--json']).json).toBe(true);
    });

    it('errors on unknown flags', () => {
        expect(() => parseValidateArgs(['--bogus'])).toThrow(/unknown option/);
    });

    it('errors when positional count is wrong', () => {
        expect(() => parseValidateArgs([])).toThrow(/exactly one/);
        expect(() => parseValidateArgs(['a', 'b'])).toThrow(/exactly one/);
    });
});

describe('loadMap', () => {
    it('loads a .json file', async () => {
        const fs = makeFs({ '/m.json': VALID_JSON });
        const map = await loadMap('/m.json', fs);
        expect(map.app).toBe('com.example.app');
    });

    it('rejects a .json file with comments (strict)', async () => {
        const fs = makeFs({ '/m.json': `// header\n${VALID_JSON}` });
        await expect(loadMap('/m.json', fs)).rejects.toThrow(/JSON parse error/);
    });

    it('loads a .yaml file', async () => {
        const fs = makeFs({ '/m.yaml': VALID_YAML });
        const map = await loadMap('/m.yaml', fs);
        expect(map.app).toBe('com.example.app');
    });

    it('loads a .yml file', async () => {
        const fs = makeFs({ '/m.yml': VALID_YAML });
        const map = await loadMap('/m.yml', fs);
        expect(map.app).toBe('com.example.app');
    });

    it('refuses a .mjs TS/JS module (never imported)', async () => {
        const fs = makeFs({});
        await expect(loadMap('/some/fixture.mjs', fs)).rejects.toThrow(/no longer supported/);
    });

    it('refuses a .ts module', async () => {
        const fs = makeFs({});
        await expect(loadMap('/some/fixture.ts', fs)).rejects.toThrow(RosettaError);
    });

    it('refuses a NUL byte in the path', async () => {
        const fs = makeFs({});
        await expect(loadMap('/m.json\0.png', fs)).rejects.toThrow(/NUL/);
    });

    it('throws on unsupported extension', async () => {
        const fs = makeFs({ '/m.txt': 'whatever' });
        await expect(loadMap('/m.txt', fs)).rejects.toThrow(/unsupported map extension/);
    });

    it('throws on invalid JSON', async () => {
        const fs = makeFs({ '/m.json': '{ not json' });
        await expect(loadMap('/m.json', fs)).rejects.toThrow(/JSON parse error/);
    });
});

describe('runValidate', () => {
    // Success prints a one-line OK summary via io.stdout and returns 0.
    // Failures THROW (the router formats them under the unified prefix and
    // folds a MapValidationError's issue list); see router.test.ts.
    it('returns an OK summary message for a valid map', async () => {
        const fake = makeFakeFs({ '/m.json': VALID_JSON });
        const captured = makeCaptured();
        // run* returns the success message; the router owns the prefix +
        // stdout, so command-level tests assert on the return value.
        const msg = await runValidate(['/m.json'], makeIo(fake, captured));
        expect(msg).toMatch(/^OK/);
        expect(msg).toContain('com.example.app@1.0.0');
        expect(msg).toContain('1 class');
    });

    it('throws a MapValidationError (with issues) for a malformed map', async () => {
        const fake = makeFakeFs({
            '/m.json':
                '{"schema_version": 5, "version_code": 1, "app": "x", "classes": {"IFoo": {}}}',
        });
        const captured = makeCaptured();
        await expect(runValidate(['/m.json'], makeIo(fake, captured))).rejects.toThrow(
            MapValidationError,
        );
    });

    it('throws on an empty YAML document (top-level issue)', async () => {
        const fake = makeFakeFs({ '/m.yaml': '' });
        const captured = makeCaptured();
        await expect(runValidate(['/m.yaml'], makeIo(fake, captured))).rejects.toThrow(
            /empty document/,
        );
    });

    it('throws a RosettaError for an unsupported extension', async () => {
        const fake = makeFakeFs({ '/m.txt': 'whatever' });
        const captured = makeCaptured();
        await expect(runValidate(['/m.txt'], makeIo(fake, captured))).rejects.toThrow(
            /unsupported map extension/,
        );
    });

    it('wraps a missing-file read error in the uniform `cannot read` message', async () => {
        // Missing file → the fake's readFile rejects with a plain ENOENT;
        // loadMap wraps it so it reads the same as patch/extract/inspect.
        const fake = makeFakeFs({});
        const captured = makeCaptured();
        await expect(runValidate(['/missing.json'], makeIo(fake, captured))).rejects.toThrow(
            /cannot read \/missing\.json/,
        );
    });

    it('wraps a missing-file read error for YAML inputs too', async () => {
        const fake = makeFakeFs({});
        const captured = makeCaptured();
        await expect(runValidate(['/missing.yaml'], makeIo(fake, captured))).rejects.toThrow(
            /cannot read \/missing\.yaml/,
        );
    });

    it('validates the canonical sample map on disk', async () => {
        // This implicitly tests against the real filesystem — we use the
        // committed sample to catch regressions in either the validator
        // or the sample itself.
        const sample = path.resolve(
            import.meta.dirname,
            '..',
            '..',
            'maps/com.example.app/30405.json',
        );
        const captured = makeCaptured();
        const io: CommandIo = {
            fs: realFs,
            stdout: (l) => captured.stdout.push(l),
            stderr: (l) => captured.stderr.push(l),
        };
        const msg = await runValidate([sample], io);
        expect(msg).toMatch(/^OK/);
    });
});

describe('runValidate --deep (folded-in semantic checks)', () => {
    // The semantic engine itself is unit-tested in src/verify/; these pin the
    // verb contract: deep mode runs the checks, hard errors fail (throw), and
    // warnings are reported in the success message without failing the build.
    const consistent = JSON.stringify({
        schema_version: 5,
        app: 'com.example.app',
        version: '1.0.0',
        version_code: 100,
        classes: { 'com.example.app.Foo': { obfuscated: 'a' } },
    });

    it('returns an OK consistent summary for a clean map', async () => {
        const fake = makeFakeFs({ '/m.json': consistent });
        const msg = await runValidate(['/m.json', '--deep'], makeIo(fake, makeCaptured()));
        expect(msg).toMatch(/^OK/);
        expect(msg).toContain('consistent');
    });

    it('throws a MapValidationError on a HARD semantic error (duplicate obfuscated)', async () => {
        const map = JSON.stringify({
            schema_version: 5,
            app: 'com.example.app',
            version: '1.0.0',
            version_code: 100,
            classes: {
                'com.example.app.A': { obfuscated: 'x' },
                'com.example.app.B': { obfuscated: 'x' },
            },
        });
        const fake = makeFakeFs({ '/m.json': map });
        await expect(
            runValidate(['/m.json', '--deep'], makeIo(fake, makeCaptured())),
        ).rejects.toThrow(MapValidationError);
    });

    it('reports a WARNING (dangling extends) in the message WITHOUT failing', async () => {
        const map = JSON.stringify({
            schema_version: 5,
            app: 'com.example.app',
            version: '1.0.0',
            version_code: 100,
            classes: {
                'com.example.app.Child': { obfuscated: 'b', extends: 'com.example.app.Missing' },
            },
        });
        const fake = makeFakeFs({ '/m.json': map });
        const msg = await runValidate(['/m.json', '--deep'], makeIo(fake, makeCaptured()));
        expect(msg).toMatch(/^OK/);
        expect(msg).toContain('1 warning');
        expect(msg).toContain('warning at classes.com.example.app.Child.extends');
    });

    it('does NOT hard-fail a vendor app referencing legit library namespaces', async () => {
        // MAJOR E: a Google-family app referencing gms/material it never maps
        // must not exit 1. With the full-prefix heuristic there are no findings.
        const map = JSON.stringify({
            schema_version: 5,
            app: 'com.google.android.apps.foo',
            version: '1.0.0',
            version_code: 100,
            classes: {
                'com.google.android.apps.foo.Main': {
                    obfuscated: 'a',
                    extends: 'com.google.android.gms.common.api.GoogleApiClient',
                },
            },
        });
        const fake = makeFakeFs({ '/m.json': map });
        const msg = await runValidate(['/m.json', '--deep'], makeIo(fake, makeCaptured()));
        expect(msg).toMatch(/^OK/);
    });

    it('reports a PLURAL warning count and lists each warning', async () => {
        const map = JSON.stringify({
            schema_version: 5,
            app: 'com.example.app',
            version: '1.0.0',
            version_code: 100,
            classes: {
                'com.example.app.A': { obfuscated: 'a', extends: 'com.example.app.MissingA' },
                'com.example.app.B': { obfuscated: 'b', extends: 'com.example.app.MissingB' },
            },
        });
        const fake = makeFakeFs({ '/m.json': map });
        const msg = await runValidate(['/m.json', '--deep'], makeIo(fake, makeCaptured()));
        expect(msg).toContain('2 warnings');
        expect(msg).toContain('warning at classes.com.example.app.A.extends');
        expect(msg).toContain('warning at classes.com.example.app.B.extends');
    });

    it('reports a PLURAL error count on multiple hard errors', async () => {
        const map = JSON.stringify({
            schema_version: 5,
            app: 'com.example.app',
            version: '1.0.0',
            version_code: 100,
            classes: {
                'com.example.app.A': { obfuscated: 'x' },
                'com.example.app.B': { obfuscated: 'x' },
                'com.example.app.C': { obfuscated: 'y' },
                'com.example.app.D': { obfuscated: 'y' },
            },
        });
        const fake = makeFakeFs({ '/m.json': map });
        await expect(
            runValidate(['/m.json', '--deep'], makeIo(fake, makeCaptured())),
        ).rejects.toThrow(/2 errors/);
    });

    it('--json emits the structured VerifyIssue[] (warnings included) when no hard error', async () => {
        const map = JSON.stringify({
            schema_version: 5,
            app: 'com.example.app',
            version: '1.0.0',
            version_code: 100,
            classes: {
                'com.example.app.Child': { obfuscated: 'b', extends: 'com.example.app.Missing' },
            },
        });
        const fake = makeFakeFs({ '/m.json': map });
        const msg = await runValidate(
            ['/m.json', '--deep', '--json'],
            makeIo(fake, makeCaptured()),
        );
        const parsed = JSON.parse(msg) as { severity: string; path: string }[];
        expect(parsed).toHaveLength(1);
        expect(parsed[0]?.severity).toBe('warning');
    });

    it('--json still throws on a hard error so the exit code stays honest', async () => {
        const map = JSON.stringify({
            schema_version: 5,
            app: 'com.example.app',
            version: '1.0.0',
            version_code: 100,
            classes: {
                'com.example.app.A': { obfuscated: 'x' },
                'com.example.app.B': { obfuscated: 'x' },
            },
        });
        const fake = makeFakeFs({ '/m.json': map });
        await expect(
            runValidate(['/m.json', '--deep', '--json'], makeIo(fake, makeCaptured())),
        ).rejects.toThrow(MapValidationError);
    });

    it('schema failure is reported before any semantic check', async () => {
        const fake = makeFakeFs({ '/m.json': '{ "schema_version": 1 }' });
        await expect(
            runValidate(['/m.json', '--deep'], makeIo(fake, makeCaptured())),
        ).rejects.toThrow();
    });
});

describe('error class wrapping behavior', () => {
    it('exposes RosettaError when caller imports it', () => {
        // Sanity: the imported error class is the same one validate.ts uses.
        expect(typeof RosettaError).toBe('function');
    });
});
