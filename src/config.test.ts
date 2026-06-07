/**
 * Tests for the typed configuration object.
 */

import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
    resolveConfig,
    DEFAULT_CONFIG,
    DEFAULT_MAX_INPUT_BYTES,
    DEFAULT_MAX_NESTING_DEPTH,
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
});
