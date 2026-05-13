/**
 * Minimal structural validator for the converter module.
 *
 * INTEGRATION NOTE: this is a placeholder. Once Agent A's full Zod
 * validator lands at `src/validate/`, callers in this folder should
 * switch from `validateStructure(...)` to that full validator. The
 * shape of the surface (in → RosettaMap or throw MapValidationError)
 * is intentionally compatible.
 */

import { z } from 'zod';
import { MapValidationError } from '../errors.js';
import type { RosettaMap } from '../types/map.js';

const MethodEntrySchema = z.object({
    obfuscated: z.string().min(1),
    signature: z.string().min(1),
    aidl_txn: z.number().int().optional(),
    static: z.boolean().optional(),
    synthetic: z.boolean().optional(),
    is_constructor: z.boolean().optional(),
});

const FieldEntrySchema = z.object({
    obfuscated: z.string().min(1),
    type: z.string().min(1),
    static: z.boolean().optional(),
});

const MapSourceSchema = z.object({
    tool: z.string().min(1),
    config: z.string().optional(),
    classes: z.number().int().nonnegative().optional(),
    notes: z.string().optional(),
    confidence: z.enum(['high', 'medium', 'low']).optional(),
});

const ClassEntrySchema = z.object({
    obfuscated: z.string().min(1),
    extends: z.string().optional(),
    kind: z
        .enum([
            'class',
            'interface',
            'enum',
            'aidl_stub',
            'aidl_callback',
            'synthetic',
            'anonymous',
        ])
        .optional(),
    dex: z.string().optional(),
    aidl_descriptor: z.string().optional(),
    anchors: z.array(z.string()).optional(),
    methods: z.record(z.union([MethodEntrySchema, z.array(MethodEntrySchema).min(1)])).optional(),
    fields: z.record(FieldEntrySchema).optional(),
    source: z.string().optional(),
    confidence: z.enum(['high', 'medium', 'low']).optional(),
});

const RosettaMapSchema = z.object({
    schema_version: z.literal(1),
    app: z.string().min(1),
    version: z.string().min(1),
    captured_at: z.string().optional(),
    apk_sha256: z.string().optional(),
    frida_min_version: z.string().optional(),
    frida_max_version: z.string().optional(),
    sources: z.array(MapSourceSchema).optional(),
    classes: z.record(ClassEntrySchema),
});

/**
 * Validate that `data` conforms to the RosettaMap schema. Returns the
 * validated map on success; throws MapValidationError on failure.
 */
export function validateStructure(data: unknown): RosettaMap {
    const result = RosettaMapSchema.safeParse(data);
    if (!result.success) {
        const issues = result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
        }));
        throw new MapValidationError(
            `map failed structural validation (${issues.length} issue${
                issues.length === 1 ? '' : 's'
            })`,
            issues,
        );
    }
    return result.data;
}
