import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadMap, looksLikeJsonSource } from './load.js';
import { JsonParseError, MapValidationError, MapInputTooLargeError } from '../errors.js';
import { resolveConfig } from '../config.js';
import type { RosettaMap } from '../types/map.js';

// Mock node:fs/promises at module-load time so loadMap routes
// path-shaped inputs through our controlled fake.
vi.mock('node:fs/promises', () => ({
    readFile: vi.fn(),
}));

// Re-import the mocked module to get a handle on the spy.
import { readFile } from 'node:fs/promises';
const readFileMock = vi.mocked(readFile);

// In the NORMALISED (in-memory) shape: methods are always arrays. loadMap
// validates + normalises, and the array form round-trips unchanged, so
// `resolves.toEqual(validMap)` holds.
const validMap: RosettaMap = {
    schema_version: 4,
    version_code: 1,
    app: 'com.example.app',
    version: '1.2.3',
    classes: {
        IFoo: {
            obfuscated: 'aaaa',
            methods: {
                bar: [{ obfuscated: 'c', signature: '()V' }],
            },
        },
    },
};

beforeEach(() => {
    readFileMock.mockReset();
});

describe('looksLikeJsonSource', () => {
    it('recognizes a leading {', () => {
        expect(looksLikeJsonSource('{}')).toBe(true);
    });

    it('recognizes a leading [', () => {
        expect(looksLikeJsonSource('[]')).toBe(true);
    });

    it('recognizes a leading " (string literal)', () => {
        expect(looksLikeJsonSource('"hi"')).toBe(true);
    });

    it('treats a leading comment marker as a path (comments are not valid JSON)', () => {
        expect(looksLikeJsonSource('// header\n{}')).toBe(false);
        expect(looksLikeJsonSource('/* header */{}')).toBe(false);
    });

    it('recognizes leading digits', () => {
        expect(looksLikeJsonSource('42')).toBe(true);
        expect(looksLikeJsonSource('-1')).toBe(true);
    });

    it('recognizes leading keyword starts (t/f/n)', () => {
        expect(looksLikeJsonSource('true')).toBe(true);
        expect(looksLikeJsonSource('false')).toBe(true);
        expect(looksLikeJsonSource('null')).toBe(true);
    });

    it('skips leading whitespace', () => {
        expect(looksLikeJsonSource('   {}')).toBe(true);
        expect(looksLikeJsonSource('\n\t{}')).toBe(true);
    });

    it('returns true for whitespace-only input (let the parser fail)', () => {
        expect(looksLikeJsonSource('   \n\t')).toBe(true);
    });

    it('treats a path-shaped string as not-source', () => {
        expect(looksLikeJsonSource('maps/com.example.app/1.2.3.json')).toBe(false);
        expect(looksLikeJsonSource('./relative/path.json')).toBe(false);
        expect(looksLikeJsonSource('C:\\Users\\x\\map.json')).toBe(false);
    });
});

describe('loadMap — object input', () => {
    it('passes through a valid object', async () => {
        await expect(loadMap(validMap)).resolves.toEqual(validMap);
    });

    it('throws MapValidationError on an invalid object', async () => {
        const bad = { schema_version: 4, version_code: 1, app: 'a' } as unknown as RosettaMap;
        await expect(loadMap(bad)).rejects.toBeInstanceOf(MapValidationError);
    });

    it('does not consult fs.readFile for object inputs', async () => {
        await loadMap(validMap);
        expect(readFileMock).not.toHaveBeenCalled();
    });
});

describe('loadMap — JSON source input', () => {
    it('parses + validates a strict-JSON literal', async () => {
        const src = JSON.stringify(validMap);
        await expect(loadMap(src)).resolves.toEqual(validMap);
        expect(readFileMock).not.toHaveBeenCalled();
    });

    it('throws JsonParseError on malformed JSON', async () => {
        await expect(loadMap('{ "bad": ')).rejects.toBeInstanceOf(JsonParseError);
    });

    it('throws JsonParseError on a JSON literal with comments (strict)', async () => {
        // A `{`-leading source is parsed in-band; the trailing comment is
        // not valid strict JSON, so it surfaces a JsonParseError.
        await expect(loadMap(`{"a":1} // trailing`)).rejects.toBeInstanceOf(JsonParseError);
    });

    it('throws MapValidationError on schema-invalid valid JSON', async () => {
        const src = '{ "schema_version": 99, "app": "a", "version": "v", "classes": {} }';
        await expect(loadMap(src)).rejects.toBeInstanceOf(MapValidationError);
    });
});

describe('loadMap — config parse limits (L9)', () => {
    it('rejects an over-size JSON source via a tightened config', async () => {
        const src = JSON.stringify(validMap);
        const config = resolveConfig({ parseLimits: { maxInputBytes: 8 } });
        await expect(loadMap(src, config)).rejects.toBeInstanceOf(MapInputTooLargeError);
    });

    it('rejects an over-deep JSON source via a tightened config', async () => {
        const config = resolveConfig({ parseLimits: { maxNestingDepth: 1 } });
        // validMap nests classes → IFoo → methods (depth > 1).
        const src = JSON.stringify(validMap);
        await expect(loadMap(src, config)).rejects.toBeInstanceOf(MapInputTooLargeError);
    });

    it('applies the guard to file-path input too', async () => {
        readFileMock.mockResolvedValueOnce(JSON.stringify(validMap));
        const config = resolveConfig({ parseLimits: { maxInputBytes: 8 } });
        await expect(loadMap('maps/x.json', config)).rejects.toBeInstanceOf(MapInputTooLargeError);
    });

    it('does NOT guard an already-constructed object input (no text path)', async () => {
        // An object never went through JSON.parse, so the byte/depth guard
        // does not apply — it validates and returns even under tiny limits.
        const config = resolveConfig({ parseLimits: { maxInputBytes: 1, maxNestingDepth: 1 } });
        await expect(loadMap(validMap, config)).resolves.toEqual(validMap);
    });

    it('uses the default config when none is passed (generous limits)', async () => {
        const src = JSON.stringify(validMap);
        await expect(loadMap(src)).resolves.toEqual(validMap);
    });
});

describe('loadMap — file path input', () => {
    it('reads the file via fs.readFile and parses it', async () => {
        readFileMock.mockResolvedValueOnce(JSON.stringify(validMap));
        await expect(loadMap('maps/x.json')).resolves.toEqual(validMap);
        expect(readFileMock).toHaveBeenCalledOnce();
        expect(readFileMock).toHaveBeenCalledWith('maps/x.json', 'utf8');
    });

    it('propagates read errors verbatim', async () => {
        readFileMock.mockRejectedValueOnce(new Error('ENOENT'));
        await expect(loadMap('maps/missing.json')).rejects.toThrow(/ENOENT/);
    });

    it('surfaces JsonParseError from on-disk malformed content', async () => {
        readFileMock.mockResolvedValueOnce('{ "broken": ');
        await expect(loadMap('maps/bad.json')).rejects.toBeInstanceOf(JsonParseError);
    });
});
