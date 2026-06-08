/**
 * Tests for the typed configuration object.
 */

import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
    resolveConfig,
    resolveVersionMatch,
    DEFAULT_CONFIG,
    DEFAULT_MAX_INPUT_BYTES,
    DEFAULT_MAX_NESTING_DEPTH,
    DEFAULT_FUZZY_MAX_DISTANCE,
    DEFAULT_FUZZY_RANKED,
} from './config.js';

describe('resolveConfig', () => {
    it('applies Kotlin-matched defaults when nothing is supplied', () => {
        const cfg = resolveConfig();
        expect(cfg.parseLimits.maxInputBytes).toBe(DEFAULT_MAX_INPUT_BYTES);
        expect(cfg.parseLimits.maxNestingDepth).toBe(DEFAULT_MAX_NESTING_DEPTH);
    });

    it('exposes the same defaults via DEFAULT_CONFIG', () => {
        expect(DEFAULT_CONFIG.parseLimits.maxInputBytes).toBe(DEFAULT_MAX_INPUT_BYTES);
        expect(DEFAULT_CONFIG.parseLimits.maxNestingDepth).toBe(DEFAULT_MAX_NESTING_DEPTH);
    });

    it('pins the defaults to the Kotlin values (8 MiB / depth 64)', () => {
        expect(DEFAULT_MAX_INPUT_BYTES).toBe(8 * 1024 * 1024);
        expect(DEFAULT_MAX_NESTING_DEPTH).toBe(64);
    });

    it('honours a partial override (only one limit)', () => {
        const cfg = resolveConfig({ parseLimits: { maxInputBytes: 1024 } });
        expect(cfg.parseLimits.maxInputBytes).toBe(1024);
        // The unspecified limit keeps its default.
        expect(cfg.parseLimits.maxNestingDepth).toBe(DEFAULT_MAX_NESTING_DEPTH);
    });

    it('honours a full override', () => {
        const cfg = resolveConfig({ parseLimits: { maxInputBytes: 10, maxNestingDepth: 3 } });
        expect(cfg.parseLimits.maxInputBytes).toBe(10);
        expect(cfg.parseLimits.maxNestingDepth).toBe(3);
    });

    it('rejects a non-positive limit', () => {
        expect(() => resolveConfig({ parseLimits: { maxInputBytes: 0 } })).toThrow(ZodError);
        expect(() => resolveConfig({ parseLimits: { maxNestingDepth: -1 } })).toThrow(ZodError);
    });

    it('rejects a non-integer limit', () => {
        expect(() => resolveConfig({ parseLimits: { maxNestingDepth: 2.5 } })).toThrow(ZodError);
    });

    it('rejects an unknown config key (strict)', () => {
        expect(() =>
            resolveConfig({ bogus: 1 } as unknown as Parameters<typeof resolveConfig>[0]),
        ).toThrow(ZodError);
    });

    it('rejects an unknown parseLimits key (strict)', () => {
        expect(() =>
            resolveConfig({
                parseLimits: { typo: 1 },
            } as unknown as Parameters<typeof resolveConfig>[0]),
        ).toThrow(ZodError);
    });

    it('defaults versionMatching to exact / off (fail-hard-by-default)', () => {
        const cfg = resolveConfig();
        expect(cfg.versionMatching.strategy).toBe('exact');
        expect(cfg.versionMatching.maxDistance).toBe(DEFAULT_FUZZY_MAX_DISTANCE);
        expect(cfg.versionMatching.ranked).toBe(DEFAULT_FUZZY_RANKED);
        expect(cfg.versionMatching.versionCodeRange).toBeUndefined();
        expect(cfg.versionMatching.versionRange).toBeUndefined();
    });

    it('pins the fuzzy defaults (no ceiling, not ranked)', () => {
        expect(DEFAULT_FUZZY_MAX_DISTANCE).toBeNull();
        expect(DEFAULT_FUZZY_RANKED).toBe(false);
    });

    it('honours a versionMatching override', () => {
        const cfg = resolveConfig({
            versionMatching: {
                strategy: 'fuzzy',
                maxDistance: 2,
                ranked: true,
                versionCodeRange: { min: 100, max: 200 },
                versionRange: { min: '1.0.0', max: '2.0.0' },
            },
        });
        expect(cfg.versionMatching.strategy).toBe('fuzzy');
        expect(cfg.versionMatching.maxDistance).toBe(2);
        expect(cfg.versionMatching.ranked).toBe(true);
        expect(cfg.versionMatching.versionCodeRange).toEqual({ min: 100, max: 200 });
        expect(cfg.versionMatching.versionRange).toEqual({ min: '1.0.0', max: '2.0.0' });
    });

    it('exposes versionMatching defaults via DEFAULT_CONFIG', () => {
        expect(DEFAULT_CONFIG.versionMatching.strategy).toBe('exact');
    });

    it('rejects an inverted versionCodeRange (min > max)', () => {
        expect(() =>
            resolveConfig({ versionMatching: { versionCodeRange: { min: 200, max: 100 } } }),
        ).toThrow(ZodError);
    });

    it('rejects a negative version_code bound', () => {
        expect(() => resolveConfig({ versionMatching: { versionCodeRange: { min: -1 } } })).toThrow(
            ZodError,
        );
    });

    it('rejects a non-integer maxDistance', () => {
        expect(() => resolveConfig({ versionMatching: { maxDistance: 1.5 } })).toThrow(ZodError);
    });

    it('rejects an unknown versionMatching key (strict)', () => {
        expect(() =>
            resolveConfig({
                versionMatching: { typo: 1 },
            } as unknown as Parameters<typeof resolveConfig>[0]),
        ).toThrow(ZodError);
    });
});

describe('resolveVersionMatch', () => {
    it('resolves undefined to the exact default', () => {
        const vm = resolveVersionMatch();
        expect(vm.strategy).toBe('exact');
        expect(vm.maxDistance).toBeNull();
        expect(vm.ranked).toBe(false);
    });

    it('resolves the legacy "exact" string', () => {
        expect(resolveVersionMatch('exact').strategy).toBe('exact');
    });

    it('resolves the legacy "fuzzy" string to fuzzy with off-by-default knobs', () => {
        const vm = resolveVersionMatch('fuzzy');
        expect(vm.strategy).toBe('fuzzy');
        expect(vm.maxDistance).toBeNull();
        expect(vm.ranked).toBe(false);
        expect(vm.versionCodeRange).toBeUndefined();
        expect(vm.versionRange).toBeUndefined();
    });

    it('resolves the object form and fills defaults', () => {
        const vm = resolveVersionMatch({ strategy: 'fuzzy', maxDistance: 3 });
        expect(vm.strategy).toBe('fuzzy');
        expect(vm.maxDistance).toBe(3);
        expect(vm.ranked).toBe(false);
    });

    it('object form defaults strategy to exact when omitted', () => {
        expect(resolveVersionMatch({ ranked: true }).strategy).toBe('exact');
    });

    it('accepts maxDistance: null explicitly (no ceiling)', () => {
        expect(
            resolveVersionMatch({ strategy: 'fuzzy', maxDistance: null }).maxDistance,
        ).toBeNull();
    });

    it('throws on an unknown object key (strict)', () => {
        expect(() =>
            resolveVersionMatch({ bogus: 1 } as unknown as Parameters<
                typeof resolveVersionMatch
            >[0]),
        ).toThrow(ZodError);
    });
});
