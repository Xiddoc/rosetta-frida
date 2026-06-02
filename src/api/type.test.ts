/**
 * Tests for `rosetta.type(realName, options)` — Tier-2 type-alias helper.
 *
 * The function is a one-liner around `Resolver.translateType(...)`.
 * Coverage targets:
 *   - Known real name → obfuscated short name.
 *   - Java primitive → passthrough.
 *   - Unmapped framework type → passthrough.
 */
import { describe, expect, it } from 'vitest';

import { createResolver } from '../resolver/index.js';
import type { RosettaMap } from '../types/map.js';
import { type } from './type.js';

const map: RosettaMap = {
    schema_version: 2,
    version_code: 1,
    app: 'com.example.app',
    version: '1.0.0',
    classes: {
        'com.example.app.Callback': { obfuscated: 'bbbb' },
    },
};

describe('type', () => {
    const resolver = createResolver(map);

    it('translates a known real name to its obfuscated form', () => {
        expect(type('com.example.app.Callback', { resolver })).toBe('bbbb');
    });

    it('passes Java primitives through verbatim', () => {
        expect(type('int', { resolver })).toBe('int');
        expect(type('boolean', { resolver })).toBe('boolean');
    });

    it('passes unmapped framework types through verbatim', () => {
        expect(type('android.os.Bundle', { resolver })).toBe('android.os.Bundle');
        expect(type('java.lang.String', { resolver })).toBe('java.lang.String');
    });
});
