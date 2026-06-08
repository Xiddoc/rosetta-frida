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

// ---------------------------------------------------------------------------
// Expanded fuzzy version matching (RFC 0001 Decision 3; issue #22)
//
// Exact `version_code` match stays the default and the highest-precedence
// selection; a miss with fuzzy disabled MUST still fail loudly. Everything
// below is STRICTLY OPT-IN: the defaults reproduce the legacy
// `versionMatch: 'exact' | 'fuzzy'` behaviour exactly (and the shared
// conformance fixture pins that legacy fuzzy ranking). The richer knobs —
// version ranges and premium nearest-match hints — only engage when a caller
// explicitly supplies the object form on a session.
// ---------------------------------------------------------------------------

/**
 * Default ceiling, in component-wise lexicographic distance space, on how far
 * a fuzzy nearest-match pick may be from the target. `null` (the default)
 * means "no ceiling" — preserve the legacy fuzzy behaviour of always picking
 * the closest registered label however far it is. A number gates the pick:
 * the closest candidate is only accepted if each of `[|Δmajor|, |Δminor|,
 * |Δpatch|]` is `<= maxDistance`, otherwise selection fails loudly.
 */
export const DEFAULT_FUZZY_MAX_DISTANCE: number | null = null;

/**
 * Whether a fuzzy pick exposes its ranked runner-up candidates by default.
 * `false` (the default) keeps the legacy single-winner shape; opting in lets
 * the caller inspect the full ranking (e.g. for diagnostics / premium hints).
 */
export const DEFAULT_FUZZY_RANKED = false;

/** A half-open / closed numeric range over the authoritative `version_code`. */
export interface VersionCodeRange {
    /** Inclusive lower bound (omit for unbounded below). */
    min?: number;
    /** Inclusive upper bound (omit for unbounded above). */
    max?: number;
}

/** A range over the `version` *label*, expressed as semver-ish bounds. */
export interface VersionLabelRange {
    /** Inclusive lower bound label (omit for unbounded below). */
    min?: string;
    /** Inclusive upper bound label (omit for unbounded above). */
    max?: string;
}

/**
 * The richer, fully-resolved version-matching policy (object form of
 * {@link VersionMatch}). The string forms `'exact'` / `'fuzzy'` normalize
 * into this shape with all opt-in knobs at their legacy-preserving defaults.
 */
export interface VersionMatchConfig {
    /**
     * Base strategy. `'exact'` (default) selects only on an exact
     * `version_code` or label; a miss fails loudly. `'fuzzy'` adds the
     * nearest-label fallback.
     */
    strategy: 'exact' | 'fuzzy';
    /**
     * Opt-in numeric range over `version_code`. When set, a map whose
     * `version_code` falls in `[min, max]` is eligible even with no exact
     * match — selected by closeness of `version_code` to the detected code
     * (or, with no detected code, the lowest code in range). Highest-priority
     * fuzzy fallback (a code range is more authoritative than a label range).
     */
    versionCodeRange?: VersionCodeRange;
    /**
     * Opt-in range over the `version` label. When set, a map whose label
     * parses into `[min, max]` (component-wise) is eligible; the closest by
     * lexicographic distance wins.
     */
    versionRange?: VersionLabelRange;
    /**
     * Opt-in ceiling on nearest-match distance (see
     * {@link DEFAULT_FUZZY_MAX_DISTANCE}). Only meaningful with
     * `strategy: 'fuzzy'`.
     */
    maxDistance?: number | null;
    /**
     * Opt-in: expose ranked runner-up candidates on the pick result (see
     * {@link DEFAULT_FUZZY_RANKED}).
     */
    ranked?: boolean;
}

/** The caller-supplied (partial) object form; every knob optional. */
export interface VersionMatchConfigInput {
    strategy?: 'exact' | 'fuzzy';
    versionCodeRange?: VersionCodeRange;
    versionRange?: VersionLabelRange;
    maxDistance?: number | null;
    ranked?: boolean;
}

/**
 * The fully-resolved, validated config. All fields are required (defaults
 * already applied). Construct one via {@link resolveConfig} from a partial
 * caller input.
 */
export interface RosettaConfig {
    /** Pre-parse input-hardening limits. */
    parseLimits: ParseLimits;
    /**
     * Default version-matching policy applied when a session does not supply
     * its own `versionMatch`. Defaults to `strategy: 'exact'` with every
     * opt-in fuzzy knob off, i.e. fail-hard-by-default (RFC 0001 Decision 3).
     */
    versionMatching: VersionMatchConfig;
}

/** The caller-supplied (partial) shape every field of which is optional. */
export interface RosettaConfigInput {
    parseLimits?: Partial<ParseLimits>;
    versionMatching?: VersionMatchConfigInput;
}

const versionCodeRangeSchema = z
    .object({
        min: z.number().int().nonnegative().optional(),
        max: z.number().int().nonnegative().optional(),
    })
    .strict()
    .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, {
        message: 'versionCodeRange.min must be <= versionCodeRange.max',
    });

const versionLabelRangeSchema = z
    .object({
        min: z.string().optional(),
        max: z.string().optional(),
    })
    .strict();

/**
 * Zod schema for the richer version-matching object form. Reused by both the
 * top-level config default (`versionMatching`) and the per-session override
 * (`SessionOptions.versionMatch`, when given the object form). The string
 * forms `'exact'` / `'fuzzy'` are normalized to this shape upstream
 * ({@link normalizeVersionMatch}); this schema validates the object form and
 * fills the legacy-preserving defaults.
 */
export const versionMatchSchema: z.ZodType<
    VersionMatchConfig,
    z.ZodTypeDef,
    VersionMatchConfigInput | undefined
> = z
    .object({
        strategy: z.enum(['exact', 'fuzzy']).default('exact'),
        versionCodeRange: versionCodeRangeSchema.optional(),
        versionRange: versionLabelRangeSchema.optional(),
        maxDistance: z.number().int().nonnegative().nullable().default(DEFAULT_FUZZY_MAX_DISTANCE),
        ranked: z.boolean().default(DEFAULT_FUZZY_RANKED),
    })
    .strict()
    .default({});

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
            versionMatching: versionMatchSchema,
        })
        .strict()
        .default({});

/**
 * Normalize a {@link VersionMatch}-shaped input (the legacy `'exact'` /
 * `'fuzzy'` string, or the richer object form, or `undefined`) into a fully
 * resolved {@link VersionMatchConfig}, applying the opt-in defaults.
 *
 * The string forms map to `{ strategy }` with every fuzzy knob at its
 * legacy-preserving default, so an existing `versionMatch: 'fuzzy'` caller is
 * byte-for-byte unchanged. `undefined` resolves to the `'exact'` default —
 * fail-hard-by-default (RFC 0001 Decision 3).
 *
 * @throws z.ZodError if the object form has a bad/unknown field (strict).
 */
export function resolveVersionMatch(
    input?: 'exact' | 'fuzzy' | VersionMatchConfigInput,
): VersionMatchConfig {
    if (input === undefined) return versionMatchSchema.parse(undefined);
    if (typeof input === 'string') return versionMatchSchema.parse({ strategy: input });
    return versionMatchSchema.parse(input);
}

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
