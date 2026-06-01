/**
 * Tests for patchMarkerBlock.
 *
 * Coverage targets:
 *   - replaces the marker block in a bundle with surrounding code
 *   - preserves all surrounding content byte-for-byte
 *   - allows replacing a single block with a single block, registry
 *     with registry, single-with-registry, and registry-with-single
 *   - surfaces MarkerBlockError when no existing block is present
 */

import { describe, expect, it } from 'vitest';
import { MarkerBlockError } from '../errors.js';
import type { RosettaMap, RosettaMapRegistry } from '../types/map.js';
import { emitMarkerBlock, emitMarkerRegistry } from './emit.js';
import { parseMarkerBlock } from './parse.js';
import { patchMarkerBlock } from './patch.js';

const map = (version = '1.2.3'): RosettaMap => ({
    schema_version: 2,
    version_code: 1,
    app: 'com.example.app',
    version,
    classes: { IFoo: { obfuscated: 'aaaa' } },
});

describe('patchMarkerBlock', () => {
    it('replaces a single-map block, preserving surrounding code', () => {
        const before = emitMarkerBlock(map('1.0.0'));
        const bundle = `// preamble\nconst greet = 1;\n${before}\nconsole.log(greet);\n`;
        const patched = patchMarkerBlock(bundle, map('2.0.0'));

        // Parse the patched bundle: must yield the new version.
        const parsed = parseMarkerBlock(patched);
        if (parsed.kind !== 'single') throw new Error('unreachable');
        expect(parsed.map.version).toBe('2.0.0');

        // Surrounding text preserved.
        expect(patched.startsWith('// preamble\nconst greet = 1;\n')).toBe(true);
        expect(patched.endsWith('\nconsole.log(greet);\n')).toBe(true);
    });

    it('promotes a single-map bundle to a registry bundle', () => {
        const before = emitMarkerBlock(map('1.0.0'));
        const bundle = `var prefix = 1;\n${before}\nvar suffix = 2;`;
        const registry: RosettaMapRegistry = { '1.0.0': map('1.0.0'), '2.0.0': map('2.0.0') };
        const patched = patchMarkerBlock(bundle, registry);
        const parsed = parseMarkerBlock(patched);
        if (parsed.kind !== 'registry') throw new Error('unreachable');
        expect(parsed.maps).toEqual(registry);
        expect(patched.startsWith('var prefix = 1;\n')).toBe(true);
        expect(patched.endsWith('\nvar suffix = 2;')).toBe(true);
    });

    it('demotes a registry bundle back to a single-map bundle', () => {
        const reg: RosettaMapRegistry = { '1.0.0': map('1.0.0') };
        const before = emitMarkerRegistry(reg);
        const bundle = `// preamble\n${before}\n// trailer`;
        const patched = patchMarkerBlock(bundle, map('2.0.0'));
        const parsed = parseMarkerBlock(patched);
        if (parsed.kind !== 'single') throw new Error('unreachable');
        expect(parsed.map.version).toBe('2.0.0');
    });

    it('throws MarkerBlockError when the bundle has no marker block', () => {
        const bundle = `console.log("no marker here");`;
        expect(() => patchMarkerBlock(bundle, map())).toThrow(MarkerBlockError);
    });

    it('is idempotent when patching with the same map', () => {
        const initial = emitMarkerBlock(map('1.2.3'));
        const bundle = `prefix\n${initial}\nsuffix`;
        const patched = patchMarkerBlock(bundle, map('1.2.3'));
        expect(patched).toBe(bundle);
    });

    it('handles a registry-payload reload preserving registry shape', () => {
        const orig: RosettaMapRegistry = { '1.0.0': map('1.0.0') };
        const bundle = `pre\n${emitMarkerRegistry(orig)}\npost`;
        const updated: RosettaMapRegistry = {
            '1.0.0': map('1.0.0'),
            '1.0.1': map('1.0.1'),
            '1.1.0': map('1.1.0'),
        };
        const patched = patchMarkerBlock(bundle, updated);
        const parsed = parseMarkerBlock(patched);
        expect(parsed.kind).toBe('registry');
        if (parsed.kind !== 'registry') throw new Error('unreachable');
        expect(Object.keys(parsed.maps).sort()).toEqual(['1.0.0', '1.0.1', '1.1.0']);
    });
});
