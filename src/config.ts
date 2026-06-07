/**
 * Typed configuration object.
 *
 * Per the project's config discipline (AGENTS.md §Memory): configuration
 * flows through ONE typed object validated against a Zod schema, not through
 * scattered `process.env` lookups or loose magic numbers. This module owns
 * the config shape, its defaults, and the validation/normalization step that
 * turns a partial caller-supplied config into a fully-resolved one.
 *
 * Today the only configurable surface is the pre-parse input-hardening
 * limits (L9 — byte size + nesting depth); the object is deliberately the
 * single home for future knobs (map paths, log levels, etc.) so the
 * configurable surface stays auditable in one place.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Pre-parse input-hardening limits (L9)
//
// A map is plain JSON parsed via the platform `JSON.parse`. Before that runs
// we apply two cheap denial-of-service guards, mirroring the Kotlin
// rosetta-xposed `MapLoader` (`MAX_INPUT_BYTES` / `MAX_NESTING_DEPTH`):
//
//   - a maximum raw input BYTE size (UTF-8), rejecting an oversized blob
//     fail-fast before it can drive a pathological parse / memory spike;
//   - a maximum structural NESTING DEPTH, rejecting deeply-nested input that
//     could blow a recursive consumer's stack.
//
// The constants match the Kotlin twin value-for-value so a map that loads on
// one client loads on the other. They are defaults: a caller may override
// either through the typed config.
// ---------------------------------------------------------------------------

/**
 * Default maximum raw map input size, in bytes (8 MiB) — counted as UTF-8
 * bytes, not UTF-16 code units. Mirrors the Kotlin `MapLoader.MAX_INPUT_BYTES`.
 */
export const DEFAULT_MAX_INPUT_BYTES = 8 * 1024 * 1024;

/**
 * Default maximum JSON structural nesting depth. Mirrors the Kotlin
 * `MapLoader.MAX_NESTING_DEPTH`.
 */
export const DEFAULT_MAX_NESTING_DEPTH = 64;

/**
 * Pre-parse input-hardening limits. Both are positive integers; both have
 * Kotlin-matched defaults. A caller may tighten or loosen either.
 */
export interface ParseLimits {
    /** Max raw input size in UTF-8 bytes. Default {@link DEFAULT_MAX_INPUT_BYTES}. */
    maxInputBytes: number;
    /** Max JSON structural nesting depth. Default {@link DEFAULT_MAX_NESTING_DEPTH}. */
    maxNestingDepth: number;
}

/**
 * The fully-resolved, validated config. All fields are required (defaults
 * already applied). Construct one via {@link resolveConfig} from a partial
 * caller input.
 */
export interface RosettaConfig {
    /** Pre-parse input-hardening limits. */
    parseLimits: ParseLimits;
}

/** The caller-supplied (partial) shape every field of which is optional. */
export interface RosettaConfigInput {
    parseLimits?: Partial<ParseLimits>;
}

/**
 * Zod schema for the resolved config. Each limit must be a positive integer;
 * `.default(...)` fills the Kotlin-matched value when the caller omits it, so
 * `parseConfig(undefined)` yields a complete {@link RosettaConfig}.
 */
export const configSchema: z.ZodType<RosettaConfig, z.ZodTypeDef, RosettaConfigInput | undefined> =
    z
        .object({
            parseLimits: z
                .object({
                    maxInputBytes: z.number().int().positive().default(DEFAULT_MAX_INPUT_BYTES),
                    maxNestingDepth: z.number().int().positive().default(DEFAULT_MAX_NESTING_DEPTH),
                })
                .strict()
                .default({}),
        })
        .strict()
        .default({});

/**
 * Validate + normalize a partial caller config into a fully-resolved
 * {@link RosettaConfig}, applying Kotlin-matched defaults for anything
 * omitted.
 *
 * @throws z.ZodError if a supplied value is not a positive integer / has an
 *   unknown key (strict).
 */
export function resolveConfig(input?: RosettaConfigInput): RosettaConfig {
    return configSchema.parse(input);
}

/** The default resolved config (all Kotlin-matched defaults). */
export const DEFAULT_CONFIG: RosettaConfig = resolveConfig();
