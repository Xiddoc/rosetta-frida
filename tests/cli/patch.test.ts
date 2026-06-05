/**
 * Tests for `rosetta patch` — replaces the embedded map in a compiled
 * bundle with one loaded from disk.
 *
 * Coverage targets:
 *   - argv parsing: required args, optional -o, dangling --map / -o,
 *     unknown option, extra positional, --output spelling
 *   - happy path with explicit -o
 *   - happy path in-place (no -o)
 *   - read errors on both bundle and map
 *   - bad map JSON (malformed)
 *   - map JSON of wrong shape (not an object, or registry with bad
 *     entries)
 *   - registry input
 *   - patchMarkerBlock failure (bundle has no marker block)
 *   - write error
 */

import { describe, expect, it } from 'vitest';
import { parsePatchArgs, runPatch } from '../../cli/commands/patch.js';
import { emitMarkerBlock, parseMarkerBlock } from '../../src/marker/index.js';
import type { RosettaMap, RosettaMapRegistry } from '../../src/types/map.js';
import { makeCaptured, makeFakeFs, makeIo } from './helpers.js';

const map = (version = '1.0.0'): RosettaMap => ({
    schema_version: 2,
    version_code: 1,
    app: 'com.example.app',
    version,
    classes: { IFoo: { obfuscated: 'aaaa' } },
});

describe('parsePatchArgs', () => {
    it('accepts <bundle> --map <map> with default in-place output', () => {
        expect(parsePatchArgs(['bundle.js', '--map', 'new.json'])).toEqual({
            bundle: 'bundle.js',
            map: 'new.json',
            output: 'bundle.js',
        });
    });

    it('accepts -o to override the output', () => {
        expect(parsePatchArgs(['bundle.js', '--map', 'new.json', '-o', 'out.js'])).toEqual({
            bundle: 'bundle.js',
            map: 'new.json',
            output: 'out.js',
        });
    });

    it('accepts --output spelling', () => {
        expect(parsePatchArgs(['bundle.js', '--map', 'new.json', '--output', 'out.js'])).toEqual({
            bundle: 'bundle.js',
            map: 'new.json',
            output: 'out.js',
        });
    });

    it('throws on missing bundle', () => {
        expect(() => parsePatchArgs(['--map', 'new.json'])).toThrow(/missing required argument/);
    });

    it('throws on missing --map', () => {
        expect(() => parsePatchArgs(['bundle.js'])).toThrow(/--map <map\.json>/);
    });

    it('throws on dangling --map', () => {
        expect(() => parsePatchArgs(['bundle.js', '--map'])).toThrow(
            /--map requires a path argument/,
        );
    });

    it('throws on dangling -o', () => {
        expect(() => parsePatchArgs(['bundle.js', '--map', 'm.json', '-o'])).toThrow(
            /-o requires a path argument/,
        );
    });

    it('throws on unknown option', () => {
        expect(() => parsePatchArgs(['bundle.js', '--bogus'])).toThrow(/unknown option/);
    });

    it('throws on extra positional', () => {
        expect(() => parsePatchArgs(['a.js', 'b.js', '--map', 'm.json'])).toThrow(
            /unexpected positional/,
        );
    });
});

describe('runPatch', () => {
    it('patches a bundle and writes to a separate output path', async () => {
        const oldMap = map('1.0.0');
        const newMap = map('2.0.0');
        const bundle = `// pre\n${emitMarkerBlock(oldMap)}\n// post`;
        const fs = makeFakeFs({
            'b.js': bundle,
            'new.json': JSON.stringify(newMap),
        });
        const captured = makeCaptured();
        const code = await runPatch(
            ['b.js', '--map', 'new.json', '-o', 'out.js'],
            makeIo(fs, captured),
        );
        expect(code).toBe(0);
        const written = fs.files.get('out.js');
        expect(written).toBeDefined();
        // The original bundle is unchanged.
        expect(fs.files.get('b.js')).toBe(bundle);
        // Surrounding context preserved.
        expect(written!.startsWith('// pre\n')).toBe(true);
        expect(written!.endsWith('\n// post')).toBe(true);
        // The new map is what's embedded now.
        const parsed = parseMarkerBlock(written!);
        if (parsed.kind !== 'single') throw new Error('unreachable');
        expect(parsed.map.version).toBe('2.0.0');
        expect(captured.stdout[0]).toMatch(/wrote out\.js$/);
    });

    it('patches in place when -o is omitted', async () => {
        const oldMap = map('1.0.0');
        const newMap = map('3.0.0');
        const bundle = emitMarkerBlock(oldMap);
        const fs = makeFakeFs({
            'b.js': bundle,
            'new.json': JSON.stringify(newMap),
        });
        const captured = makeCaptured();
        const code = await runPatch(['b.js', '--map', 'new.json'], makeIo(fs, captured));
        expect(code).toBe(0);
        const updated = fs.files.get('b.js')!;
        const parsed = parseMarkerBlock(updated);
        if (parsed.kind !== 'single') throw new Error('unreachable');
        expect(parsed.map.version).toBe('3.0.0');
        expect(captured.stdout[0]).toMatch(/in place/);
    });

    it('accepts a registry payload in the map JSON', async () => {
        const reg: RosettaMapRegistry = {
            '1.0.0': map('1.0.0'),
            '2.0.0': map('2.0.0'),
        };
        const fs = makeFakeFs({
            'b.js': emitMarkerBlock(map('0.9.0')),
            'reg.json': JSON.stringify(reg),
        });
        const captured = makeCaptured();
        const code = await runPatch(['b.js', '--map', 'reg.json'], makeIo(fs, captured));
        expect(code).toBe(0);
        const updated = fs.files.get('b.js')!;
        const parsed = parseMarkerBlock(updated);
        expect(parsed.kind).toBe('registry');
    });

    it('exits 1 with usage error when args are malformed', async () => {
        const fs = makeFakeFs();
        const captured = makeCaptured();
        const code = await runPatch([], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/patch:.*missing required argument/);
    });

    it('exits 1 when bundle file cannot be read', async () => {
        const fs = makeFakeFs({
            'm.json': '{"schema_version":2,"version_code":1,"app":"x","version":"y","classes":{}}',
        });
        const captured = makeCaptured();
        const code = await runPatch(['missing.js', '--map', 'm.json'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/cannot read bundle/);
    });

    it('exits 1 when map file cannot be read', async () => {
        const fs = makeFakeFs({ 'b.js': emitMarkerBlock(map()) });
        const captured = makeCaptured();
        const code = await runPatch(['b.js', '--map', 'missing.json'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/cannot read map/);
    });

    it('exits 1 when map source is malformed JSON', async () => {
        const fs = makeFakeFs({
            'b.js': emitMarkerBlock(map()),
            'bad.json': '{ this is not JSON',
        });
        const captured = makeCaptured();
        const code = await runPatch(['b.js', '--map', 'bad.json'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/map is malformed/);
    });

    it('exits 1 when a map carries comments (strict JSON only)', async () => {
        const fs = makeFakeFs({
            'b.js': emitMarkerBlock(map()),
            'm.json':
                '// canonical map with comments\n' +
                '{\n' +
                '    "schema_version": 2,\n' +
                '    "version_code": 1,\n' +
                '    "app": "com.example.app",\n' +
                '    "version": "3.5.0",\n' +
                '    "classes": {}\n' +
                '}\n',
        });
        const captured = makeCaptured();
        const code = await runPatch(['b.js', '--map', 'm.json'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/map is malformed/);
    });

    it('accepts a strict-JSON map', async () => {
        const fs = makeFakeFs({
            'b.js': emitMarkerBlock(map()),
            'm.json':
                '{\n' +
                '    "schema_version": 2,\n' +
                '    "version_code": 1,\n' +
                '    "app": "com.example.app",\n' +
                '    "version": "3.5.0",\n' +
                '    "classes": {}\n' +
                '}\n',
        });
        const captured = makeCaptured();
        const code = await runPatch(['b.js', '--map', 'm.json'], makeIo(fs, captured));
        expect(code).toBe(0);
    });

    it('exits 1 when map is not an object', async () => {
        const fs = makeFakeFs({
            'b.js': emitMarkerBlock(map()),
            'arr.json': '[1, 2, 3]',
        });
        const captured = makeCaptured();
        const code = await runPatch(['b.js', '--map', 'arr.json'], makeIo(fs, captured));
        // Array is typeof 'object' but lacks schema_version; falls through
        // to registry check, where its values (1, 2, 3) lack schema_version.
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/neither a RosettaMap.*nor a registry/);
    });

    it('exits 1 when map is a primitive at top level', async () => {
        const fs = makeFakeFs({
            'b.js': emitMarkerBlock(map()),
            'num.json': '42',
        });
        const captured = makeCaptured();
        const code = await runPatch(['b.js', '--map', 'num.json'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/must be an object at top level/);
    });

    it('exits 1 when map is null at top level', async () => {
        const fs = makeFakeFs({
            'b.js': emitMarkerBlock(map()),
            'null.json': 'null',
        });
        const captured = makeCaptured();
        const code = await runPatch(['b.js', '--map', 'null.json'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/must be an object at top level/);
    });

    it('exits 1 when registry-shape map has a non-object value', async () => {
        const fs = makeFakeFs({
            'b.js': emitMarkerBlock(map()),
            'badreg.json': JSON.stringify({ '1.0.0': 'not-an-object' }),
        });
        const captured = makeCaptured();
        const code = await runPatch(['b.js', '--map', 'badreg.json'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/neither a RosettaMap.*nor a registry/);
    });

    it('exits 1 when bundle has no marker block', async () => {
        const fs = makeFakeFs({
            'b.js': 'console.log("no marker");',
            'new.json': JSON.stringify(map()),
        });
        const captured = makeCaptured();
        const code = await runPatch(['b.js', '--map', 'new.json'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/no rosetta-frida marker block/);
    });

    it('exits 1 when output cannot be written', async () => {
        const fs = makeFakeFs({
            'b.js': emitMarkerBlock(map()),
            'new.json': JSON.stringify(map('9.9.9')),
        });
        fs.writeErrors.set('out.js', new Error('EACCES'));
        const captured = makeCaptured();
        const code = await runPatch(
            ['b.js', '--map', 'new.json', '-o', 'out.js'],
            makeIo(fs, captured),
        );
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/cannot write output.*EACCES/);
    });

    it('allows -o with a parent-traversal path (operator may write outside CWD)', async () => {
        const oldMap = map('1.0.0');
        const newMap = map('9.9.9');
        const fs = makeFakeFs({
            'b.js': emitMarkerBlock(oldMap),
            'new.json': JSON.stringify(newMap),
        });
        const captured = makeCaptured();
        const code = await runPatch(
            ['b.js', '--map', 'new.json', '-o', '../escape.js'],
            makeIo(fs, captured),
        );
        expect(code).toBe(0);
        expect(fs.files.has('../escape.js')).toBe(true);
        // The original bundle is untouched.
        expect(fs.files.get('b.js')).toBe(emitMarkerBlock(oldMap));
    });

    it('allows -o with an absolute path outside the project tree', async () => {
        const fs = makeFakeFs({
            'b.js': emitMarkerBlock(map()),
            'new.json': JSON.stringify(map('9.9.9')),
        });
        const captured = makeCaptured();
        const code = await runPatch(
            ['b.js', '--map', 'new.json', '-o', '/tmp/out.js'],
            makeIo(fs, captured),
        );
        expect(code).toBe(0);
        expect(fs.files.has('/tmp/out.js')).toBe(true);
    });

    it('allows in-place patch when the bundle path is outside CWD', async () => {
        // No -o: output defaults to the bundle path — operator-supplied, so
        // containment is not enforced; only NUL is rejected.
        const originalBundle = emitMarkerBlock(map());
        const fs = makeFakeFs({
            '../outside.js': originalBundle,
            'new.json': JSON.stringify(map('5.0.0')),
        });
        const captured = makeCaptured();
        const code = await runPatch(['../outside.js', '--map', 'new.json'], makeIo(fs, captured));
        expect(code).toBe(0);
        expect(fs.files.has('../outside.js')).toBe(true);
        expect(captured.stdout[0]).toMatch(/in place/);
    });

    it('exits 1 when -o contains a NUL byte', async () => {
        const fs = makeFakeFs({
            'b.js': emitMarkerBlock(map()),
            'new.json': JSON.stringify(map('9.9.9')),
        });
        const captured = makeCaptured();
        const code = await runPatch(
            ['b.js', '--map', 'new.json', '-o', 'out.js\0.png'],
            makeIo(fs, captured),
        );
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/NUL/);
    });
});
