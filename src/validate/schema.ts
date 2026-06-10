/**
 * Zod schemas mirroring `src/types/map.ts`.
 *
 * The on-disk JSON is parsed into a plain JS value (`unknown`) and
 * then validated through these schemas. A successful validation
 * returns a `RosettaMap` exactly matching the locked TypeScript
 * contract.
 *
 * Validation errors throw `MapValidationError` carrying a structured
 * list of `{path, message}` entries derived from Zod's `ZodIssue[]` —
 * one per invalid field — so callers can render a useful failure
 * report without parsing message strings.
 *
 * Compatibility story (one story, not two):
 *
 *   - `schema_version` is a HARD GATE (`z.literal(CURRENT_SCHEMA_VERSION)`).
 *     A map whose `schema_version` differs — older OR newer — is REJECTED.
 *     There is deliberately NO cross-version forward-compat: a wrong-version
 *     map silently corrupts hooks, so an exact miss must fail loudly (RFC
 *     0001 Decision 7 / AGENTS.md §7). Bumping the format means re-emitting
 *     the map at the new version, not best-effort reading the old/new one.
 *
 *   - WITHIN the pinned version, the fixed-shape objects (the top-level
 *     map, each `MapSource`, `MethodEntry`, `FieldEntry`, and `ClassEntry`)
 *     are STRICT (`.strict()`): an unknown / mistyped sibling key is
 *     REJECTED, not silently stripped. This mirrors the canonical maps
 *     schema, which went `additionalProperties: false` on every structured
 *     object (frida#17 M6 / maps#6), so a typo'd key (`signature` →
 *     `signatuer`) fails loudly on both clients instead of being dropped and
 *     producing a subtly wrong map. The user-KEYED records (`classes`,
 *     `methods`, `fields`) are NOT strict — their keys are real names and
 *     therefore arbitrary by design (the canonical schema models them with
 *     `additionalProperties: <ref>`); the bounded-record guard still caps
 *     their cardinality and rejects prototype-pollution keys.
 *
 * So: strict on the version key AND on every fixed-shape object's key set;
 * arbitrary only where the keys ARE the data (the real-name records).
 */

import { z } from 'zod';
import { CURRENT_SCHEMA_VERSION } from '../types/map.js';
import type {
    ClassKind,
    FieldEntry,
    GeneratedFrom,
    MapSource,
    MapStatus,
    MethodEntry,
    RosettaMap,
    RosettaMapInput,
} from '../types/map.js';
import { MapValidationError } from '../errors.js';

// ---------------------------------------------------------------------------
// Security input bounds (M1)
//
// These caps mirror the canonical JSON Schema in the rosetta-maps repo
// (`schema/rosetta-map.schema.json`). They keep the Zod validator and the
// canonical schema identical so a hostile or corrupt map fails validation
// early — before it can drive unbounded work in the resolver or shadow
// object internals via reserved record keys. Keep these in lockstep with
// the canonical schema; do not diverge.
// ---------------------------------------------------------------------------

/** Max number of class entries in a single map. */
export const MAX_CLASSES = 50_000;
/** Max number of methods on a single class. */
export const MAX_METHODS_PER_CLASS = 5_000;
/** Max number of fields on a single class. */
export const MAX_FIELDS_PER_CLASS = 5_000;
/** Max number of overloads in a single method-map value array. */
export const MAX_METHOD_OVERLOADS = 200;
/** Max number of provenance sources on a map. */
export const MAX_SOURCES = 100;
/** Max length for obfuscated / short-name strings. */
export const MAX_SHORT_NAME_LEN = 512;
/** Max length for JVM descriptor signatures. */
export const MAX_SIGNATURE_LEN = 4_096;
/** Max length for the `app` package name. */
export const MAX_APP_LEN = 256;
/** Max length for the `version` label. */
export const MAX_VERSION_LEN = 256;
/** Max length for any other free-form string. */
export const MAX_FREE_STRING_LEN = 4_096;
/**
 * Maximum value for `version_code` — the full Android `longVersionCode`
 * (`(versionCodeMajor << 32) | versionCode`), capped at
 * `Number.MAX_SAFE_INTEGER` (2^53 − 1). Apps that set `versionCodeMajor`
 * legitimately exceed 2^31, so the value is NOT masked to its low 32 bits
 * (that would alias distinct releases). The cap is 2^53 − 1 because the
 * Frida client reads this through a JS `Number`, which is only exact up to
 * `Number.MAX_SAFE_INTEGER`; all realistic `longVersionCode` values fit
 * well inside it. Kept in lockstep with the canonical rosetta-maps schema
 * (`maximum: 9007199254740991`) and rosetta-xposed's `MAX_VERSION_CODE`.
 */
export const MAX_VERSION_CODE = Number.MAX_SAFE_INTEGER;

/**
 * Record keys that must never appear in a map's `classes` / `methods` /
 * `fields` objects. They would shadow `Object.prototype` slots and let a
 * hostile map smuggle a prototype-pollution / footgun lookup through the
 * resolver's bracket-indexed access. We reject the *map* rather than
 * sanitise it, so the failure is loud at validation time.
 */
export const RESERVED_RECORD_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/**
 * Wrap a `z.record(...)` schema with a max-entry cardinality cap and a
 * reserved-key rejection.
 *
 * The reserved-key check runs against the **raw input** via a preceding
 * `superRefine`, not the parsed output: `JSON.parse('{"__proto__":…}')`
 * produces a genuine own `__proto__` key (the prototype-pollution vector),
 * but Zod's record parser silently drops `__proto__` while building its
 * fresh output object — so a post-parse check would never see it. We use
 * `Object.getOwnPropertyNames` on the raw value to catch all three
 * reserved names (`__proto__`, `constructor`, `prototype`) and the
 * cardinality cap, then `.pipe(...)` into the real record schema for the
 * value validation. The wrapper preserves the record's output type.
 */
function boundedRecord<T extends z.ZodTypeAny>(
    schema: z.ZodRecord<z.ZodString, T>,
    maxEntries: number,
    label: string,
): z.ZodType<
    z.output<z.ZodRecord<z.ZodString, T>>,
    z.ZodTypeDef,
    z.input<z.ZodRecord<z.ZodString, T>>
> {
    const guard = z.unknown().superRefine((value, ctx) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            // Shape errors are reported by the piped record schema.
            return;
        }
        const keys = Object.getOwnPropertyNames(value);
        if (keys.length > maxEntries) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `${label} has ${keys.length} entries; the maximum is ${maxEntries}`,
            });
        }
        for (const key of keys) {
            if (RESERVED_RECORD_KEYS.includes(key)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: [key],
                    message: `reserved key '${key}' is not allowed in ${label}`,
                });
            }
        }
    });
    // Why the `as unknown as` double-cast (a deliberate, contained escape
    // hatch — not laziness):
    //
    // `guard.pipe(schema)` is a `ZodPipeline<ZodUnknown, typeof schema>`. Its
    // OUTPUT type is already exactly `z.output<schema>` (the pipe runs the
    // record schema second, so the parsed value IS the record). The only lie
    // is the INPUT type: a pipeline reports its FIRST stage's input, and the
    // guard is `z.unknown()`, so `z.input<pipeline>` widens to `unknown`
    // instead of the record's `z.input` (the scalar-or-array authoring shape).
    //
    // We can't narrow that input without making the guard itself a typed
    // schema — but a typed guard would re-run the record's value validation a
    // second time (the guard exists ONLY to pre-scan raw keys for the
    // cardinality cap and reserved names; value validation belongs to the
    // piped record alone). So we keep the cheap `z.unknown()` guard and
    // re-assert the declared input here. TypeScript needs `as unknown as`
    // because `unknown` is not assignable to the record input directly; the
    // surrounding `z.input`/`z.output` lock assertions still police drift.
    return guard.pipe(schema) as unknown as z.ZodType<
        z.output<z.ZodRecord<z.ZodString, T>>,
        z.ZodTypeDef,
        z.input<z.ZodRecord<z.ZodString, T>>
    >;
}

// ---------------------------------------------------------------------------
// Leaf schemas
// ---------------------------------------------------------------------------

export const classKindSchema: z.ZodType<ClassKind> = z.union([
    z.literal('class'),
    z.literal('interface'),
    z.literal('enum'),
    z.literal('synthetic'),
    z.literal('anonymous'),
]);

// The fixed-shape objects below are all `.strict()`: an unknown / mistyped
// sibling key is REJECTED, not silently stripped. This is the canonical
// cross-client strict-keys policy — the canonical rosetta-maps schema went
// `additionalProperties: false` on every structured object, and the Kotlin
// rosetta-xposed twin matches it (its model rejects unknown keys too). So a
// typo'd key fails loudly on both clients rather than producing a subtly
// wrong map. Keep these in lockstep; do not relax to a passthrough object.
export const mapSourceSchema: z.ZodType<MapSource> = z
    .object({
        tool: z.string().min(1).max(MAX_FREE_STRING_LEN),
        config: z.string().max(MAX_FREE_STRING_LEN).optional(),
        classes: z.number().int().optional(),
        notes: z.string().max(MAX_FREE_STRING_LEN).optional(),
    })
    .strict();

export const methodEntrySchema: z.ZodType<MethodEntry> = z
    .object({
        obfuscated: z.string().min(1).max(MAX_SHORT_NAME_LEN),
        signature: z.string().min(1).max(MAX_SIGNATURE_LEN),
        static: z.boolean().optional(),
        synthetic: z.boolean().optional(),
        is_constructor: z.boolean().optional(),
    })
    .strict();

export const fieldEntrySchema: z.ZodType<FieldEntry> = z
    .object({
        obfuscated: z.string().min(1).max(MAX_SHORT_NAME_LEN),
        type: z.string().min(1).max(MAX_SIGNATURE_LEN),
        static: z.boolean().optional(),
    })
    .strict();

/**
 * A method-map value is either a single MethodEntry or an array of them
 * (the multi-overload form). Both forms are accepted on input; the value is
 * NORMALISED to an array (the single form becomes a one-element array) so
 * the in-memory {@link MethodMap} is always `Record<string, MethodEntry[]>`
 * and consumers never branch on array-vs-single. The array form requires at
 * least one overload — an empty overload list is semantically meaningless.
 */
export const methodMapValueSchema: z.ZodType<
    MethodEntry[],
    z.ZodTypeDef,
    MethodEntry | MethodEntry[]
> = z
    .union([methodEntrySchema, z.array(methodEntrySchema).min(1).max(MAX_METHOD_OVERLOADS)])
    .transform((value) => (Array.isArray(value) ? value : [value]));

export const methodMapSchema = boundedRecord(
    z.record(z.string(), methodMapValueSchema),
    MAX_METHODS_PER_CLASS,
    'methods',
);

export const fieldMapSchema = boundedRecord(
    z.record(z.string(), fieldEntrySchema),
    MAX_FIELDS_PER_CLASS,
    'fields',
);

export const classEntrySchema = z
    .object({
        obfuscated: z.string().min(1).max(MAX_SHORT_NAME_LEN),
        extends: z.string().max(MAX_FREE_STRING_LEN).optional(),
        kind: classKindSchema.optional(),
        dex: z.string().max(MAX_FREE_STRING_LEN).optional(),
        methods: methodMapSchema.optional(),
        fields: fieldMapSchema.optional(),
        source: z.string().max(MAX_FREE_STRING_LEN).optional(),
    })
    .strict();

export const classMapSchema = boundedRecord(
    z.record(z.string(), classEntrySchema),
    MAX_CLASSES,
    'classes',
);

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

/**
 * Android package-name shape: at least two dot-separated segments, and EVERY
 * segment must start with a letter (e.g. `com.example.app`). A digit-first
 * segment (`com.2example.app`) or a single un-dotted token (`myapp`) is
 * rejected. Mirrors the tightened canonical schema's `app` pattern.
 */
export const APP_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/**
 * The `version` label must contain at least one non-whitespace character —
 * a whitespace-only label (e.g. `'   '`) is rejected. Mirrors the canonical
 * maps schema's `"pattern": "\\S"` (maps#13 / frida#17 M17). Non-mutating:
 * the original string is preserved (the schema does not trim it).
 */
export const VERSION_PATTERN = /\S/;

/**
 * Lowercase 64-char hex — the SHA-256 of the signing certificate. The
 * session layer normalises (lowercases) and re-validates this at runtime;
 * the schema enforces the canonical lowercase-hex shape so a malformed map
 * fails validation early rather than at attach time. Bare hex only — the
 * MAP value never carries colons or uppercase (those are accepted only on
 * the runtime app-presented hash, which the signer guard normalises before
 * comparison), so a guard-accepted map value is always schema-valid (#32).
 */
export const SIGNER_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * ISO calendar date `YYYY-MM-DD` (#39). Mirrors JSON-Schema `format: "date"`
 * semantics: a four-digit year, two-digit month `01–12`, two-digit day
 * `01–31`. This field-range check is the FIRST gate; {@link isRealCalendarDate}
 * then rejects impossible days (`2026-02-30`, `2026-04-31`, a non-leap
 * `2025-02-29`) so the client matches what a `format: "date"` checker and the
 * canonical schema enforce — arbitrary free text (the old schema-2 behaviour)
 * is rejected.
 */
export const CAPTURED_AT_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * True iff `value` is a real calendar date (not merely a `YYYY-MM-DD`-shaped
 * string). The pattern accepts any day `01–31`, so it lets impossible dates
 * (`2026-02-30`, `2026-04-31`, `2025-02-29` in a non-leap year) through. We
 * round-trip the parsed components through `Date.UTC` and require every
 * component to survive unchanged: JS normalizes an overflow day into the next
 * month (`Date.UTC(2026, 1, 30)` becomes March 2), so a mismatch on any of
 * year/month/day means the input named a day that does not exist. UTC is used
 * so the check is timezone-independent. Assumes `value` already matched
 * {@link CAPTURED_AT_PATTERN}, so the slice indices are sound.
 */
export function isRealCalendarDate(value: string): boolean {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

/**
 * Abbreviated-or-full git commit hash (`generated_from.signatures_rev`, #36):
 * 7–40 lowercase hex characters.
 */
export const SIGNATURES_REV_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * A single bare-hex signer digest. Shared by the string and array forms of
 * `signer_sha256` (#38).
 */
const signerSha256Atom = z.string().regex(SIGNER_SHA256_PATTERN, {
    message: 'signer_sha256 must be 64 lowercase hex characters',
});

/**
 * `signer_sha256`: EITHER a single bare-hex digest OR a non-empty array of
 * them (match-any, #38/#32). The array form requires at least one entry — an
 * empty array would pin no signer and is meaningless. There is deliberately NO
 * upper bound on the array: the canonical schema has `minItems: 1` and no
 * `maxItems`, so capping here would make this client stricter than the schema
 * (and signers are not sources — they have nothing to do with `MAX_SOURCES`).
 */
export const signerSha256Schema: z.ZodType<string | string[]> = z.union([
    signerSha256Atom,
    z.array(signerSha256Atom).min(1),
]);

/** `generated_from` (#36): present ⇒ `signatures_rev` required. */
export const generatedFromSchema: z.ZodType<GeneratedFrom> = z
    .object({
        signatures_rev: z.string().regex(SIGNATURES_REV_PATTERN, {
            message: 'signatures_rev must be 7–40 lowercase hex characters (a git commit hash)',
        }),
    })
    .strict();

/** Lifecycle `status` enum (#40). Absent ⇒ active. */
export const mapStatusSchema: z.ZodType<MapStatus> = z.union([
    z.literal('active'),
    z.literal('superseded'),
    z.literal('retracted'),
]);

/**
 * Top-level map schema. Intentionally UNANNOTATED so Zod infers both sides
 * of the transform: `z.input<typeof rosettaMapSchema>` is the authoring
 * shape (scalar-or-array methods, i.e. {@link RosettaMapInput}) and
 * `z.output<typeof rosettaMapSchema>` is the normalised {@link RosettaMap}
 * (always-array methods). Annotating it `z.ZodType<RosettaMap>` would erase
 * `z.input`, leaving emitters of the authoring form (the sigmatcher adapter)
 * with nowhere to hand their value but a lying cast.
 */
export const rosettaMapSchema = z
    .object({
        schema_version: z.literal(CURRENT_SCHEMA_VERSION),
        app: z.string().min(1).max(MAX_APP_LEN).regex(APP_PATTERN, {
            message: 'app must be a dotted package name (e.g. com.example.app)',
        }),
        version: z.string().min(1).max(MAX_VERSION_LEN).regex(VERSION_PATTERN, {
            message: 'version must contain a non-whitespace character',
        }),
        version_code: z.number().int().nonnegative().max(MAX_VERSION_CODE),
        captured_at: z
            .string()
            .regex(CAPTURED_AT_PATTERN, {
                message: 'captured_at must be an ISO date (YYYY-MM-DD)',
            })
            .refine(isRealCalendarDate, {
                message: 'captured_at must be a real calendar date (YYYY-MM-DD)',
            })
            .optional(),
        signer_sha256: signerSha256Schema.optional(),
        generated_from: generatedFromSchema.optional(),
        status: mapStatusSchema.optional(),
        superseded_by: z.number().int().nonnegative().max(MAX_VERSION_CODE).optional(),
        client_hints: z
            .object({
                frida_min_version: z.string().max(MAX_FREE_STRING_LEN).optional(),
                frida_max_version: z.string().max(MAX_FREE_STRING_LEN).optional(),
            })
            .strict()
            .optional(),
        sources: z.array(mapSourceSchema).max(MAX_SOURCES).optional(),
        classes: classMapSchema,
    })
    .strict()
    // Cross-field lifecycle rule (#40): `superseded_by` is meaningful ONLY for
    // a superseded map. Absent `status` means active. So:
    //   - status === 'superseded'  ⇒  superseded_by REQUIRED.
    //   - any other status (active / absent / retracted)  ⇒  superseded_by
    //     FORBIDDEN.
    // This mirrors the canonical maps schema's Python validator, which enforces
    // the same pairing; without it this client would silently accept maps the
    // maps repo rejects (a parity drift). A retracted map names no replacement
    // here — withdrawal and "use this newer map instead" are distinct states.
    .superRefine((map, ctx) => {
        const isSuperseded = map.status === 'superseded';
        if (isSuperseded && map.superseded_by === undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['superseded_by'],
                message: "superseded_by is required when status is 'superseded'",
            });
        }
        if (!isSuperseded && map.superseded_by !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['superseded_by'],
                message: "superseded_by is only allowed when status is 'superseded'",
            });
        }
    });

/**
 * The authoring/input type the schema accepts. Equal to the hand-written
 * {@link RosettaMapInput} contract (scalar-or-array methods) — kept provably
 * in lockstep via the assertions below.
 */
export type RosettaMapSchemaInput = z.input<typeof rosettaMapSchema>;
/** The normalised output type the schema produces (always-array methods). */
export type RosettaMapSchemaOutput = z.output<typeof rosettaMapSchema>;

// Compile-time lock: the inferred input/output match the hand-written
// contracts. If the schema and `src/types/map.ts` ever drift, one of these
// stops type-checking. (`Extends` is a structural mutual-assignability check.)
type Extends<A, B> = A extends B ? (B extends A ? true : never) : never;
const _inputMatches: Extends<RosettaMapSchemaInput, RosettaMapInput> = true;
const _outputMatches: Extends<RosettaMapSchemaOutput, RosettaMap> = true;
void _inputMatches;
void _outputMatches;

// ---------------------------------------------------------------------------
// Public validator entry point
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value as a RosettaMap.
 *
 * @throws MapValidationError if the value does not satisfy the schema.
 *         The thrown error's `issues` array carries one `{path, message}`
 *         entry per invalid field (Zod's flattened `ZodIssue` list).
 */
export function validateMap(data: unknown): RosettaMap {
    const result = rosettaMapSchema.safeParse(data);
    if (result.success) {
        return result.data;
    }
    // L6 — schema-version mismatch gets a dedicated, actionable message.
    //
    // The `schema_version` literal gate (`z.literal(CURRENT_SCHEMA_VERSION)`)
    // otherwise reports a generic "Invalid literal value, expected 2" Zod
    // issue, which neither names the version the map carries nor tells the
    // author what to do about it. When the input is an object that DID supply
    // a numeric `schema_version` differing from the supported literal, surface
    // a single, clearer issue that states found-vs-expected and points at the
    // remedy. The remedy DIFFERS by direction, because there is no
    // cross-version forward-compat (a wrong-version map must be re-emitted at
    // the supported version, not best-effort read; see the module header /
    // RFC 0001 Decision 7):
    //
    //   - NEWER map (found > current): this build cannot read it and cannot
    //     downgrade it — the user must UPGRADE their rosetta-frida install to
    //     a build that supports that version.
    //   - OLDER map (found < current): re-emit it at the current version.
    //
    // In BOTH directions the remedy tooling (`rosetta migrate`) is only
    // PLANNED, not shipped, so the message says so honestly rather than
    // implying a runnable command exists today.
    const found = foundSchemaVersion(data);
    if (found !== undefined && found !== CURRENT_SCHEMA_VERSION) {
        const preamble =
            `Map has schema_version ${found}, but this build of rosetta-frida only ` +
            `supports schema_version ${CURRENT_SCHEMA_VERSION}.`;
        const remedy =
            found > CURRENT_SCHEMA_VERSION
                ? `That map is NEWER than this build understands and cannot be downgraded; ` +
                  `upgrade rosetta-frida to a build that supports schema_version ${found} ` +
                  `and reload it. (A \`rosetta migrate\` command is planned but not yet shipped.)`
                : `There is no cross-version auto-upgrade: re-emit the map at version ` +
                  `${CURRENT_SCHEMA_VERSION} and reload it. (A \`rosetta migrate\` command to ` +
                  `do this is planned but not yet shipped.)`;
        const message = `${preamble} ${remedy}`;
        throw new MapValidationError(message, [{ path: 'schema_version', message }]);
    }
    const issues = result.error.issues.map((issue) => ({
        path: zodPathToString(issue.path),
        message: issue.message,
    }));
    const summary = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
    throw new MapValidationError(`Map failed schema validation (${summary})`, issues);
}

/**
 * Read a numeric `schema_version` off an unknown input, or `undefined` if the
 * input is not an object or did not supply a numeric `schema_version`. Used by
 * {@link validateMap} to give a wrong-but-numeric version a dedicated
 * migration-hint message (L6); a missing / non-numeric `schema_version` (and
 * `NaN`, which is technically `typeof 'number'` but names no version) falls
 * through to the normal Zod issue list instead.
 */
function foundSchemaVersion(data: unknown): number | undefined {
    if (typeof data !== 'object' || data === null) {
        return undefined;
    }
    const value = (data as { schema_version?: unknown }).schema_version;
    return typeof value === 'number' && !Number.isNaN(value) ? value : undefined;
}

/**
 * Stringify a Zod issue path. Numeric indices and string keys are
 * joined with `.`; the root path becomes the empty string.
 *
 * Exported for testing.
 */
export function zodPathToString(path: ReadonlyArray<PropertyKey>): string {
    // Numeric indices, string keys, and symbols all stringify the same way.
    return path.map(String).join('.');
}
