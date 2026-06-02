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
 * Unknown keys are accepted (and stripped) so additive schema
 * evolution doesn't break older library versions reading newer maps.
 */

import { z } from 'zod';
import { CURRENT_SCHEMA_VERSION } from '../types/map.js';
import type {
    ClassEntry,
    ClassKind,
    Confidence,
    FieldEntry,
    MapSource,
    MethodEntry,
    RosettaMap,
} from '../types/map.js';
import { MapValidationError } from '../errors.js';

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
    tool: z.string().min(1),
    config: z.string().optional(),
    classes: z.number().int().optional(),
    notes: z.string().optional(),
    confidence: confidenceSchema.optional(),
});

export const methodEntrySchema: z.ZodType<MethodEntry> = z.object({
    obfuscated: z.string().min(1),
    signature: z.string().min(1),
    aidl_txn: z.number().int().optional(),
    static: z.boolean().optional(),
    synthetic: z.boolean().optional(),
    is_constructor: z.boolean().optional(),
});

export const fieldEntrySchema: z.ZodType<FieldEntry> = z.object({
    obfuscated: z.string().min(1),
    type: z.string().min(1),
    static: z.boolean().optional(),
});

/**
 * A method-map value is either a single MethodEntry or an array of them
 * (the multi-overload form). Both forms are accepted on input. The
 * array form requires at least one overload — an empty overload list
 * is semantically meaningless.
 */
export const methodMapValueSchema: z.ZodType<MethodEntry | MethodEntry[]> = z.union([
    methodEntrySchema,
    z.array(methodEntrySchema).min(1),
]);

export const methodMapSchema = z.record(z.string(), methodMapValueSchema);

export const fieldMapSchema = z.record(z.string(), fieldEntrySchema);

export const classEntrySchema: z.ZodType<ClassEntry> = z.object({
    obfuscated: z.string().min(1),
    extends: z.string().optional(),
    kind: classKindSchema.optional(),
    dex: z.string().optional(),
    aidl_descriptor: z.string().optional(),
    anchors: z.array(z.string()).optional(),
    methods: methodMapSchema.optional(),
    fields: fieldMapSchema.optional(),
    source: z.string().optional(),
    confidence: confidenceSchema.optional(),
});

export const classMapSchema = z.record(z.string(), classEntrySchema);

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

export const rosettaMapSchema: z.ZodType<RosettaMap> = z.object({
    schema_version: z.literal(CURRENT_SCHEMA_VERSION),
    app: z.string().min(1),
    version: z.string().min(1),
    version_code: z.number().int().nonnegative(),
    captured_at: z.string().optional(),
    signer_sha256: z.string().optional(),
    frida_min_version: z.string().optional(),
    frida_max_version: z.string().optional(),
    sources: z.array(mapSourceSchema).optional(),
    classes: classMapSchema,
});

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
