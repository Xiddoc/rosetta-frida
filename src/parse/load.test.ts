import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadMap, looksLikeJsoncSource } from './load.js';
import { JsoncParseError, MapValidationError } from '../errors.js';
import type { RosettaMap } from '../types/map.js';

// Mock node:fs/promises at module-load time so loadMap routes
// path-shaped inputs through our controlled fake.
vi.mock('node:fs/promises', () => ({
    readFile: vi.fn(),
}));

// Re-import the mocked module to get a handle on the spy.
import { readFile } from 'node:fs/promises';
const readFileMock = vi.mocked(readFile);

const validMap: RosettaMap = {
    schema_version: 1,
    app: 'com.example.app',
    version: '1.2.3',
    classes: {
        IFoo: {
            obfuscated: 'aaaa',
            methods: {
                bar: { obfuscated: 'c', signature: '()V' },
            },
        },
    },
};

beforeEach(() => {
    readFileMock.mockReset();
});

describe('looksLikeJsoncSource', () => {
    it('recognizes a leading {', () => {
        expect(looksLikeJsoncSource('{}')).toBe(true);
    });

    it('recognizes a leading [', () => {
        expect(looksLikeJsoncSource('[]')).toBe(true);
    });

    it('recognizes a leading " (string literal)', () => {
        expect(looksLikeJsoncSource('"hi"')).toBe(true);
    });

    it('recognizes a leading comment marker', () => {
        expect(looksLikeJsoncSource('// header\n{}')).toBe(true);
        expect(looksLikeJsoncSource('/* header */{}')).toBe(true);
    });

    it('recognizes leading digits', () => {
        expect(looksLikeJsoncSource('42')).toBe(true);
        expect(looksLikeJsoncSource('-1')).toBe(true);
    });

    it('recognizes leading keyword starts (t/f/n)', () => {
        expect(looksLikeJsoncSource('true')).toBe(true);
        expect(looksLikeJsoncSource('false')).toBe(true);
        expect(looksLikeJsoncSource('null')).toBe(true);
    });

    it('skips leading whitespace', () => {
        expect(looksLikeJsoncSource('   {}')).toBe(true);
        expect(looksLikeJsoncSource('\n\t{}')).toBe(true);
    });

    it('returns true for whitespace-only input (let the parser fail)', () => {
        expect(looksLikeJsoncSource('   \n\t')).toBe(true);
    });

    it('treats a path-shaped string as not-source', () => {
        expect(looksLikeJsoncSource('maps/com.example.app/1.2.3.jsonc')).toBe(false);
        expect(looksLikeJsoncSource('./relative/path.json')).toBe(false);
        expect(looksLikeJsoncSource('C:\\Users\\x\\map.json')).toBe(false);
    });
});

describe('loadMap — object input', () => {
    it('passes through a valid object', async () => {
        await expect(loadMap(validMap)).resolves.toEqual(validMap);
    });

    it('throws MapValidationError on an invalid object', async () => {
        const bad = { schema_version: 1, app: 'a' } as unknown as RosettaMap;
        await expect(loadMap(bad)).rejects.toBeInstanceOf(MapValidationError);
    });

    it('does not consult fs.readFile for object inputs', async () => {
        await loadMap(validMap);
        expect(readFileMock).not.toHaveBeenCalled();
    });
});

describe('loadMap — JSONC source input', () => {
    it('parses + validates a JSONC literal', async () => {
        const src = `// header\n${JSON.stringify(validMap)}`;
        await expect(loadMap(src)).resolves.toEqual(validMap);
        expect(readFileMock).not.toHaveBeenCalled();
    });

    it('throws JsoncParseError on malformed JSONC', async () => {
        await expect(loadMap('{ "bad": ')).rejects.toBeInstanceOf(JsoncParseError);
    });

    it('throws MapValidationError on schema-invalid valid JSONC', async () => {
        const src = '{ "schema_version": 99, "app": "a", "version": "v", "classes": {} }';
        await expect(loadMap(src)).rejects.toBeInstanceOf(MapValidationError);
    });
});

describe('loadMap — file path input', () => {
    it('reads the file via fs.readFile and parses it', async () => {
        readFileMock.mockResolvedValueOnce(JSON.stringify(validMap));
        await expect(loadMap('maps/x.jsonc')).resolves.toEqual(validMap);
        expect(readFileMock).toHaveBeenCalledOnce();
        expect(readFileMock).toHaveBeenCalledWith('maps/x.jsonc', 'utf8');
    });

    it('handles a JSONC file with comments', async () => {
        readFileMock.mockResolvedValueOnce(`// header\n${JSON.stringify(validMap)}`);
        await expect(loadMap('maps/x.jsonc')).resolves.toEqual(validMap);
    });

    it('propagates read errors verbatim', async () => {
        readFileMock.mockRejectedValueOnce(new Error('ENOENT'));
        await expect(loadMap('maps/missing.jsonc')).rejects.toThrow(/ENOENT/);
    });

    it('surfaces JsoncParseError from on-disk malformed content', async () => {
        readFileMock.mockResolvedValueOnce('{ "broken": ');
        await expect(loadMap('maps/bad.jsonc')).rejects.toBeInstanceOf(JsoncParseError);
    });
});
