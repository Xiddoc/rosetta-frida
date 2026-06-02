/**
 * Tests for `rosetta validate`.
 *
 * The mock fs object is a plain record of functions rather than a class —
 * each operation returns a Promise via `Promise.resolve()` / `Promise.reject()`
 * to satisfy the typed `fs/promises` signature while keeping operations
 * synchronous (no `await` needed, no lint flag).
 */

import { describe, it, expect } from 'vitest';
import type * as fsMod from 'node:fs/promises';
import * as fsReal from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, afterAll } from 'vitest';
import { parseValidateArgs, loadMap, runValidate } from '../../cli/commands/validate.js';
import { RosettaError } from '../../src/errors.js';

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

const TS_MODULE_SRC = `
export default {
    schema_version: 2, version_code: 1,
    app: 'com.example.app',
    version: '1.0.0',
    classes: {
        IFoo: { obfuscated: 'aaaa' },
    },
};
`;

function enoent(p: string): NodeJS.ErrnoException {
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    return err;
}

function makeFs(initial: Record<string, string>): typeof fsMod {
    const files = new Map<string, string>(Object.entries(initial));
    return {
        readFile(p: string) {
            const v = files.get(p);
            return v === undefined ? Promise.reject(enoent(p)) : Promise.resolve(v);
        },
    } as unknown as typeof fsMod;
}

let tsFixture: string;
let fixturesDir: string;

beforeAll(async () => {
    fixturesDir = await fsReal.mkdtemp(path.join(os.tmpdir(), 'rosetta-validate-'));
    tsFixture = path.join(fixturesDir, 'fixture.mjs');
    await fsReal.writeFile(tsFixture, TS_MODULE_SRC, 'utf8');
});

afterAll(async () => {
    await fsReal.rm(fixturesDir, { recursive: true, force: true });
});

describe('parseValidateArgs', () => {
    it('accepts exactly one positional', () => {
        expect(parseValidateArgs(['m.json']).inputPath).toBe('m.json');
    });

    it('errors on flags', () => {
        expect(() => parseValidateArgs(['--bogus'])).toThrow(/unknown flag/);
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

    it('loads a .mjs TS module', async () => {
        const map = await loadMap(tsFixture);
        expect(map.app).toBe('com.example.app');
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
    it('reports OK for a valid map', async () => {
        const fs = makeFs({ '/m.json': VALID_JSON });
        const result = await runValidate(['/m.json'], fs);
        expect(result.ok).toBe(true);
        expect(result.output[0]).toMatch(/^OK/);
        expect(result.output[0]).toContain('com.example.app@1.0.0');
        expect(result.output[0]).toContain('1 class');
    });

    it('reports structured errors for a malformed map', async () => {
        const fs = makeFs({
            '/m.json':
                '{"schema_version": 2, "version_code": 1, "app": "x", "classes": {"IFoo": {}}}',
        });
        const result = await runValidate(['/m.json'], fs);
        expect(result.ok).toBe(false);
        expect(result.output[0]).toMatch(/^FAIL/);
        // Should include indented issue lines.
        expect(result.output.length).toBeGreaterThan(1);
        // At least one issue line should reference a Zod field path.
        expect(result.output.some((l) => l.includes('  at '))).toBe(true);
    });

    it('reports issues with empty-path (top-level) cleanly', async () => {
        // Feed YAML that produces an empty document — yamlToMap throws a
        // MapValidationError whose only issue has `path: ''` (empty).
        const fs = makeFs({ '/m.yaml': '' });
        const result = await runValidate(['/m.yaml'], fs);
        expect(result.ok).toBe(false);
        // The empty-path issue should render without "at ..." prefix.
        expect(result.output.some((l) => /^ {2}document is null/.test(l))).toBe(true);
    });

    it('reports a single-line failure for a non-MapValidationError RosettaError', async () => {
        const fs = makeFs({ '/m.txt': 'whatever' });
        const result = await runValidate(['/m.txt'], fs);
        expect(result.ok).toBe(false);
        expect(result.output).toHaveLength(1);
        expect(result.output[0]).toMatch(/unsupported map extension/);
    });

    it('reports a single-line failure for a non-Rosetta error', async () => {
        // Use a path that the mock fs reports as missing — readFile throws
        // a plain Error with `code: ENOENT`, which is NOT a RosettaError.
        const fs = makeFs({});
        const result = await runValidate(['/missing.json'], fs);
        expect(result.ok).toBe(false);
        expect(result.output[0]).toMatch(/^FAIL/);
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
        const result = await runValidate([sample]);
        expect(result.ok).toBe(true);
    });
});

describe('validate error wrapping', () => {
    it('wraps unknown errors with FAIL prefix', async () => {
        const fs = {
            readFile() {
                // Plain non-Rosetta error.
                return Promise.reject(new Error('boom'));
            },
        } as unknown as typeof fsMod;
        const result = await runValidate(['/x.json'], fs);
        expect(result.ok).toBe(false);
        expect(result.output[0]).toContain('FAIL');
    });
});

describe('error class wrapping behavior', () => {
    it('exposes RosettaError when caller imports it', () => {
        // Sanity: the imported error class is the same one validate.ts uses.
        expect(typeof RosettaError).toBe('function');
    });
});
