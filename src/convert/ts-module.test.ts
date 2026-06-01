/**
 * Tests for the TS/JS module → RosettaMap converter.
 *
 * Fixtures are written to a temp directory in `beforeAll` rather than
 * committed source files — that way ESLint never tries to parse them
 * (they're not real source) and `import()` still resolves them cleanly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsModuleToMap } from './ts-module.js';
import { MapValidationError, RosettaError } from '../errors.js';

const DEFAULT_EXPORT_SRC = `
export default {
    schema_version: 2, version_code: 1,
    app: 'com.example.app',
    version: '1.0.0',
    classes: {
        IFoo: { obfuscated: 'aaaa' },
    },
};
`;

const NAMED_EXPORT_SRC = `
export const map = {
    schema_version: 2, version_code: 1,
    app: 'com.example.app',
    version: '2.0.0',
    classes: {
        IBar: { obfuscated: 'bbbb' },
    },
};
`;

const NO_EXPORT_SRC = `
export const unrelated = 42;
`;

const INVALID_EXPORT_SRC = `
export default {
    schema_version: 2, version_code: 1,
    app: '',
    version: '',
    classes: {},
};
`;

let fixturesDir: string;
let defaultExportPath: string;
let namedExportPath: string;
let noExportPath: string;
let invalidExportPath: string;

beforeAll(async () => {
    fixturesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rosetta-ts-module-'));
    defaultExportPath = path.join(fixturesDir, 'default-export.mjs');
    namedExportPath = path.join(fixturesDir, 'named-export.mjs');
    noExportPath = path.join(fixturesDir, 'no-export.mjs');
    invalidExportPath = path.join(fixturesDir, 'invalid-export.mjs');
    await Promise.all([
        fs.writeFile(defaultExportPath, DEFAULT_EXPORT_SRC, 'utf8'),
        fs.writeFile(namedExportPath, NAMED_EXPORT_SRC, 'utf8'),
        fs.writeFile(noExportPath, NO_EXPORT_SRC, 'utf8'),
        fs.writeFile(invalidExportPath, INVALID_EXPORT_SRC, 'utf8'),
    ]);
});

afterAll(async () => {
    await fs.rm(fixturesDir, { recursive: true, force: true });
});

describe('tsModuleToMap', () => {
    it('loads a map from a module default export (absolute path)', async () => {
        const map = await tsModuleToMap(defaultExportPath);
        expect(map.app).toBe('com.example.app');
        expect(map.version).toBe('1.0.0');
        expect(map.classes.IFoo?.obfuscated).toBe('aaaa');
    });

    it('loads a map from a module named `map` export', async () => {
        const map = await tsModuleToMap(namedExportPath);
        expect(map.app).toBe('com.example.app');
        expect(map.version).toBe('2.0.0');
        expect(map.classes.IBar?.obfuscated).toBe('bbbb');
    });

    it('accepts a file:// URL directly', async () => {
        const url = pathToFileURL(defaultExportPath).href;
        const map = await tsModuleToMap(url);
        expect(map.classes.IFoo?.obfuscated).toBe('aaaa');
    });

    it('accepts a relative path', async () => {
        const rel = path.relative(process.cwd(), defaultExportPath);
        const map = await tsModuleToMap(rel);
        expect(map.classes.IFoo?.obfuscated).toBe('aaaa');
    });

    it('throws RosettaError when the module cannot be loaded', async () => {
        await expect(tsModuleToMap('/nonexistent/path.mjs')).rejects.toThrow(RosettaError);
    });

    it('throws RosettaError when the module has no map/default export', async () => {
        await expect(tsModuleToMap(noExportPath)).rejects.toThrow(/no `default` or `map` export/);
    });

    it('throws MapValidationError when the exported map is invalid', async () => {
        await expect(tsModuleToMap(invalidExportPath)).rejects.toThrow(MapValidationError);
    });

    // Export the fixture paths so other tests in the project can use them.
    it('exposes fixture paths via setup (sanity)', () => {
        expect(defaultExportPath).toBeTruthy();
    });
});

/** Exported for the jsonc/convert tests that also want a TS-module path. */
export function getFixturePaths(): {
    defaultExport: string;
    namedExport: string;
    noExport: string;
    invalidExport: string;
} {
    return {
        defaultExport: defaultExportPath,
        namedExport: namedExportPath,
        noExport: noExportPath,
        invalidExport: invalidExportPath,
    };
}
