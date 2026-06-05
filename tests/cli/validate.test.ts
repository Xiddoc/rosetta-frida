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
    "schema_version": 2,
    "app": "com.example.app",
    "version": "1.0.0",
    "version_code": 100,
    "classes": {
        "IFoo": { "obfuscated": "aaaa" }
    }
}`;

const VALID_YAML = `
schema_version: 2
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
        expect(parseValidateArgs(['m.json']).inputPath).toBe('m.json');
    });

    it('errors on flags', () => {
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
                '{"schema_version": 2, "version_code": 1, "app": "x", "classes": {"IFoo": {}}}',
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
            'maps/com.example.app/3.4.5.json',
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

describe('error class wrapping behavior', () => {
    it('exposes RosettaError when caller imports it', () => {
        // Sanity: the imported error class is the same one validate.ts uses.
        expect(typeof RosettaError).toBe('function');
    });
});
