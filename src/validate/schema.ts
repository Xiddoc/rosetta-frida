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
 *   - WITHIN the pinned version, unknown object keys are accepted and
 *     STRIPPED (Zod's default object behaviour). This tolerates additive,
 *     non-breaking annotations a newer minor emitter might attach to a
 *     `schema_version: 2` map (extra provenance, hints, etc.) without
 *     failing validation — they simply don't surface in the typed result.
 *
 * So: strict on the version key, lenient on unknown sibling keys at the
 * same version. The two are not in tension — they operate at different
 * granularities (whole-format vs. individual fields).
 */

import { z } from 'zod';
import { CURRENT_SCHEMA_VERSION } from '../types/map.js';
import type {
    ClassKind,
    Confidence,
    FieldEntry,
    MapSource,
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
/** Max number of anchors on a single class. */
export const MAX_ANCHORS = 1_000;
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
/** Maximum value for `version_code` — the low 32 bits of Android `longVersionCode` (2^31 − 1). */
export const MAX_VERSION_CODE = 2_147_483_647;

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
    return guard.pipe(schema) as unknown as z.ZodType<
        z.output<z.ZodRecord<z.ZodString, T>>,
        z.ZodTypeDef,
        z.input<z.ZodRecord<z.ZodString, T>>
    >;
}

// ---------------------------------------------------------------------------
// Leaf schemas
// ---------------------------------------------------------------------------

export const confidenceSchema: z.ZodType<Confidence> = z.union([
    z.literal('high'),
    z.literal('medium'),
    z.literal('low'),
]);

export const classKindSchema: z.ZodType<ClassKind> = z.union([
    z.literal('class'),
    z.literal('interface'),
    z.literal('enum'),
    z.literal('aidl_stub'),
    z.literal('aidl_callback'),
    z.literal('synthetic'),
    z.literal('anonymous'),
]);

export const mapSourceSchema: z.ZodType<MapSource> = z.object({
    tool: z.string().min(1).max(MAX_FREE_STRING_LEN),
    config: z.string().max(MAX_FREE_STRING_LEN).optional(),
    classes: z.number().int().optional(),
    notes: z.string().max(MAX_FREE_STRING_LEN).optional(),
    confidence: confidenceSchema.optional(),
});

export const methodEntrySchema: z.ZodType<MethodEntry> = z.object({
    obfuscated: z.string().min(1).max(MAX_SHORT_NAME_LEN),
    signature: z.string().min(1).max(MAX_SIGNATURE_LEN),
    aidl_txn: z.number().int().optional(),
    static: z.boolean().optional(),
    synthetic: z.boolean().optional(),
    is_constructor: z.boolean().optional(),
});

export const fieldEntrySchema: z.ZodType<FieldEntry> = z.object({
    obfuscated: z.string().min(1).max(MAX_SHORT_NAME_LEN),
    type: z.string().min(1).max(MAX_SIGNATURE_LEN),
    static: z.boolean().optional(),
});

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

export const classEntrySchema = z.object({
    obfuscated: z.string().min(1).max(MAX_SHORT_NAME_LEN),
    extends: z.string().max(MAX_FREE_STRING_LEN).optional(),
    kind: classKindSchema.optional(),
    dex: z.string().max(MAX_FREE_STRING_LEN).optional(),
    aidl_descriptor: z.string().max(MAX_FREE_STRING_LEN).optional(),
    anchors: z.array(z.string().max(MAX_FREE_STRING_LEN)).max(MAX_ANCHORS).optional(),
    methods: methodMapSchema.optional(),
    fields: fieldMapSchema.optional(),
    source: z.string().max(MAX_FREE_STRING_LEN).optional(),
    confidence: confidenceSchema.optional(),
});

export const classMapSchema = boundedRecord(
    z.record(z.string(), classEntrySchema),
    MAX_CLASSES,
    'classes',
);

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

/**
 * Android package-name shape: a leading identifier segment followed by at
 * least one dotted segment (e.g. `com.example.app`). Mirrors the canonical
 * schema's `app` pattern.
 */
export const APP_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

/**
 * Lowercase 64-char hex — the SHA-256 of the signing certificate. The
 * session layer normalises (lowercases) and re-validates this at runtime;
 * the schema enforces the canonical lowercase-hex shape so a malformed map
 * fails validation early rather than at attach time.
 */
export const SIGNER_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Top-level map schema. Intentionally UNANNOTATED so Zod infers both sides
 * of the transform: `z.input<typeof rosettaMapSchema>` is the authoring
 * shape (scalar-or-array methods, i.e. {@link RosettaMapInput}) and
 * `z.output<typeof rosettaMapSchema>` is the normalised {@link RosettaMap}
 * (always-array methods). Annotating it `z.ZodType<RosettaMap>` would erase
 * `z.input`, leaving emitters of the authoring form (the sigmatcher adapter)
 * with nowhere to hand their value but a lying cast.
 */
export const rosettaMapSchema = z.object({
    schema_version: z.literal(CURRENT_SCHEMA_VERSION),
    app: z.string().min(1).max(MAX_APP_LEN).regex(APP_PATTERN, {
        message: 'app must be a dotted package name (e.g. com.example.app)',
    }),
    version: z.string().min(1).max(MAX_VERSION_LEN),
    version_code: z.number().int().nonnegative().max(MAX_VERSION_CODE),
    captured_at: z.string().max(MAX_FREE_STRING_LEN).optional(),
    signer_sha256: z
        .string()
        .regex(SIGNER_SHA256_PATTERN, {
            message: 'signer_sha256 must be 64 lowercase hex characters',
        })
        .optional(),
    frida_min_version: z.string().max(MAX_FREE_STRING_LEN).optional(),
    frida_max_version: z.string().max(MAX_FREE_STRING_LEN).optional(),
    sources: z.array(mapSourceSchema).max(MAX_SOURCES).optional(),
    classes: classMapSchema,
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
    const issues = result.error.issues.map((issue) => ({
        path: zodPathToString(issue.path),
        message: issue.message,
    }));
    const summary = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
    throw new MapValidationError(`Map failed schema validation (${summary})`, issues);
}

/**
 * Stringify a Zod issue path. Numeric indices and string keys are
 * joined with `.`; the root path becomes the empty string.
 *
 * Exported for testing.
 */
export function zodPathToString(path: ReadonlyArray<PropertyKey>): string {
    return path
        .map((segment) => (typeof segment === 'number' ? String(segment) : String(segment)))
        .join('.');
}
