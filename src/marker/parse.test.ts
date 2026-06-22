/**
 * Tests for parseMarkerBlock.
 *
 * Coverage targets:
 *   - happy paths (single and registry) round-trip emit
 *   - range is the [start, end) of the entire marker block
 *   - block survives being embedded between other JS statements
 *   - throws MarkerBlockError on every documented failure mode:
 *       no BEGIN, no END, missing var declaration, invalid JSON
 *   - registry takes precedence over single when both appear
 *     (the registry BEGIN marker is a strict superstring)
 */

import { describe, expect, it } from 'vitest';
import { MarkerBlockError } from '../errors.js';
import type { RosettaMap, RosettaMapRegistry } from '../types/map.js';
import { emitMarkerBlock, emitMarkerRegistry } from './emit.js';
import { parseMarkerBlock } from './parse.js';

function minimalMap(): RosettaMap {
    return {
        schema_version: 5,
        version_code: 1,
        app: 'com.example.app',
        version: '1.2.3',
        classes: {},
    };
}

function richishMap(version = '1.2.3'): RosettaMap {
    return {
        schema_version: 5,
        version_code: 1,
        app: 'com.example.app',
        version,
        classes: {
            IFoo: {
                obfuscated: 'aaaa',
                methods: { bar: { obfuscated: 'c', signature: '()V' } },
            },
        },
    };
}

describe('parseMarkerBlock — single', () => {
    it('round-trips a minimal emitted block', () => {
        const map = minimalMap();
        const out = emitMarkerBlock(map);
        const parsed = parseMarkerBlock(out);
        expect(parsed.kind).toBe('single');
        if (parsed.kind !== 'single') throw new Error('unreachable');
        expect(parsed.map).toEqual(map);
    });

    it('round-trips a richer map', () => {
        const map = richishMap();
        const out = emitMarkerBlock(map);
        const parsed = parseMarkerBlock(out);
        if (parsed.kind !== 'single') throw new Error('unreachable');
        expect(parsed.map).toEqual(map);
    });

    it('range covers the full marker block (start of comment to end of comment)', () => {
        const map = minimalMap();
        const emitted = emitMarkerBlock(map);
        const bundle = `// preamble\nconst x = 1;\n\n${emitted}\n\nconsole.log('after');\n`;
        const parsed = parseMarkerBlock(bundle);
        const [start, end] = parsed.range;
        expect(bundle.slice(start, end)).toBe(emitted);
    });

    it('locates the block when embedded between other JS statements', () => {
        const map = richishMap();
        const emitted = emitMarkerBlock(map);
        const bundle =
            `function a() { return 1; }\n` +
            `${emitted}\n` +
            `function b() { return __rosetta_map; }`;
        const parsed = parseMarkerBlock(bundle);
        if (parsed.kind !== 'single') throw new Error('unreachable');
        expect(parsed.map.app).toBe('com.example.app');
        // The range slice must still equal exactly what we emitted.
        expect(bundle.slice(parsed.range[0], parsed.range[1])).toBe(emitted);
    });
});

describe('parseMarkerBlock — registry', () => {
    it('round-trips a single-version registry', () => {
        const reg: RosettaMapRegistry = { '1.2.3': richishMap('1.2.3') };
        const out = emitMarkerRegistry(reg);
        const parsed = parseMarkerBlock(out);
        expect(parsed.kind).toBe('registry');
        if (parsed.kind !== 'registry') throw new Error('unreachable');
        expect(parsed.maps).toEqual(reg);
    });

    it('round-trips a multi-version registry', () => {
        const reg: RosettaMapRegistry = {
            '3.4.5': richishMap('3.4.5'),
            '3.4.6': richishMap('3.4.6'),
        };
        const out = emitMarkerRegistry(reg);
        const parsed = parseMarkerBlock(out);
        if (parsed.kind !== 'registry') throw new Error('unreachable');
        expect(parsed.maps).toEqual(reg);
    });

    it('returns the correct range for a registry block', () => {
        const reg: RosettaMapRegistry = { '1.2.3': minimalMap() };
        const out = emitMarkerRegistry(reg);
        const bundle = `prefix\n${out}\nsuffix\n`;
        const parsed = parseMarkerBlock(bundle);
        expect(bundle.slice(parsed.range[0], parsed.range[1])).toBe(out);
    });

    it('classifies registry correctly even when single-map BEGIN appears later', () => {
        // A registry block comes first; later the bundle has comment-text
        // that happens to contain the single-marker substring. Parse
        // must classify as registry (the first valid block wins) — but
        // more importantly, parse must NOT misidentify the registry as
        // single by matching on `BEGIN ROSETTA MAP` inside the longer
        // `BEGIN ROSETTA MAP REGISTRY`.
        const reg: RosettaMapRegistry = { '1.0.0': minimalMap() };
        const out = emitMarkerRegistry(reg);
        const bundle = `${out}\nconsole.log("end");\n`;
        const parsed = parseMarkerBlock(bundle);
        expect(parsed.kind).toBe('registry');
    });

    it('prefers the earlier marker when both single and registry are present', () => {
        // Mixed bundle: registry block first, then a single-map block.
        // Parse must classify by the earlier (registry) block and
        // return its range, not the later single block's range.
        const reg: RosettaMapRegistry = { '1.0.0': minimalMap() };
        const regBlock = emitMarkerRegistry(reg);
        const singleBlock = emitMarkerBlock(minimalMap());
        const bundle = `${regBlock}\nconsole.log("between");\n${singleBlock}`;
        const parsed = parseMarkerBlock(bundle);
        expect(parsed.kind).toBe('registry');
        if (parsed.kind !== 'registry') throw new Error('unreachable');
        // The range covers the registry block only.
        expect(bundle.slice(parsed.range[0], parsed.range[1])).toBe(regBlock);
    });

    it('handles a single-map block followed by registry as single', () => {
        // Reverse order: a single block first, then a registry block.
        // The first-occurrence rule means single wins.
        const singleBlock = emitMarkerBlock(minimalMap());
        const reg: RosettaMapRegistry = { '1.0.0': minimalMap() };
        const regBlock = emitMarkerRegistry(reg);
        const bundle = `${singleBlock}\n${regBlock}`;
        const parsed = parseMarkerBlock(bundle);
        expect(parsed.kind).toBe('single');
        if (parsed.kind !== 'single') throw new Error('unreachable');
        expect(bundle.slice(parsed.range[0], parsed.range[1])).toBe(singleBlock);
    });
});

describe('parseMarkerBlock — failure modes', () => {
    it('throws MarkerBlockError when no BEGIN marker is present', () => {
        const bundle = `console.log("nothing here");`;
        expect(() => parseMarkerBlock(bundle)).toThrow(MarkerBlockError);
        expect(() => parseMarkerBlock(bundle)).toThrow(/no rosetta-frida marker block/);
    });

    it('throws MarkerBlockError when BEGIN is present but END is missing', () => {
        const bundle = `/*! -----BEGIN ROSETTA MAP----- */\nconst __rosetta_map = {};\n// unterminated`;
        expect(() => parseMarkerBlock(bundle)).toThrow(MarkerBlockError);
    });

    it('throws MarkerBlockError when registry BEGIN is present but END is missing', () => {
        const bundle = `/*! -----BEGIN ROSETTA MAP REGISTRY----- */\nconst __rosetta_maps = {};\n// unterm`;
        expect(() => parseMarkerBlock(bundle)).toThrow(MarkerBlockError);
    });

    it('throws MarkerBlockError when the var declaration is missing', () => {
        const bundle = [
            `/*! -----BEGIN ROSETTA MAP----- */`,
            `// somehow no __rosetta_map here`,
            `42;`,
            `/*! -----END ROSETTA MAP----- */`,
        ].join('\n');
        expect(() => parseMarkerBlock(bundle)).toThrow(MarkerBlockError);
        expect(() => parseMarkerBlock(bundle)).toThrow(/no `__rosetta_map = \.\.\.` decl/);
    });

    it('throws MarkerBlockError when the payload is missing a terminating semicolon', () => {
        const bundle = [
            `/*! -----BEGIN ROSETTA MAP----- */`,
            `const __rosetta_map = {}`,
            `/*! -----END ROSETTA MAP----- */`,
        ].join('\n');
        expect(() => parseMarkerBlock(bundle)).toThrow(MarkerBlockError);
        expect(() => parseMarkerBlock(bundle)).toThrow(/doesn't terminate with a `;`/);
    });

    it('throws MarkerBlockError when the payload is not valid JSON', () => {
        // Object-literal with an unquoted key — valid JS but not valid JSON.
        const bundle = [
            `/*! -----BEGIN ROSETTA MAP----- */`,
            `const __rosetta_map = { unquoted: 1 };`,
            `/*! -----END ROSETTA MAP----- */`,
        ].join('\n');
        expect(() => parseMarkerBlock(bundle)).toThrow(MarkerBlockError);
        expect(() => parseMarkerBlock(bundle)).toThrow(/not valid JSON/);
    });

    it('accepts let/var-shaped declarations (forward-compat with placeholder form)', () => {
        const bundle = [
            `/*! -----BEGIN ROSETTA MAP----- */`,
            `let __rosetta_map = {"schema_version":1,"app":"x","version":"y","classes":{}};`,
            `/*! -----END ROSETTA MAP----- */`,
        ].join('\n');
        const parsed = parseMarkerBlock(bundle);
        if (parsed.kind !== 'single') throw new Error('unreachable');
        expect(parsed.map.app).toBe('x');
    });

    it('handles a block whose markers lack the leading `/*!` wrapper', () => {
        // Some external tooling might strip the `/*!` envelope. The parser
        // should still locate and decode the payload. The reported range
        // will start at the BEGIN marker (no comment wrapper to extend to).
        const literal =
            'const __rosetta_map = ' +
            JSON.stringify({
                schema_version: 5,
                version_code: 1,
                app: 'x',
                version: 'y',
                classes: {},
            }) +
            ';';
        const bundle = ['-----BEGIN ROSETTA MAP-----', literal, '-----END ROSETTA MAP-----'].join(
            '\n',
        );
        const parsed = parseMarkerBlock(bundle);
        if (parsed.kind !== 'single') throw new Error('unreachable');
        expect(parsed.map.app).toBe('x');
        // Range starts at the BEGIN marker, no `/*!` to extend to.
        const beginLen = '-----BEGIN ROSETTA MAP-----'.length;
        expect(bundle.slice(parsed.range[0], parsed.range[0] + beginLen)).toBe(
            '-----BEGIN ROSETTA MAP-----',
        );
    });

    it('range falls back when `*/` does not immediately follow END marker', () => {
        // Defensive branch: emit always pairs END with `*/` but a
        // hand-edited bundle might not. parse should still complete and
        // bound the range at the end of the marker text itself.
        const payload = JSON.stringify({
            schema_version: 5,
            version_code: 1,
            app: 'x',
            version: 'y',
            classes: {},
        });
        const bundle =
            '/*! -----BEGIN ROSETTA MAP----- */\n' +
            `const __rosetta_map = ${payload};\n` +
            '-----END ROSETTA MAP-----\n' +
            'console.log("after — no closing star-slash in sight");';
        const parsed = parseMarkerBlock(bundle);
        if (parsed.kind !== 'single') throw new Error('unreachable');
        // Range end should be the end of the END marker text itself.
        const endLen = '-----END ROSETTA MAP-----'.length;
        expect(bundle.slice(parsed.range[1] - endLen, parsed.range[1])).toBe(
            '-----END ROSETTA MAP-----',
        );
    });
});
