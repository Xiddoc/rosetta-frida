/**
 * Sigmatcher → RosettaMap adapter.
 *
 * Sigmatcher emits a `raw`-format JSON object keyed by signature
 * *definition* name (one entry per YAML `Definition:` block). For
 * single-overload methods the definition name is typically the same as
 * the real method name, but multi-overload methods must be authored as
 * two separate definitions because sigmatcher's name-keyed model does
 * not natively express overloading.
 *
 * The adapter:
 *
 *   1. Walks every definition in the raw object.
 *   2. Composes the real fully-qualified class name from
 *      `original.package` + `original.name`.
 *   3. Builds JVM-descriptor method signatures from
 *      `new.argument_types` + `new.return_type` ("(args)ret").
 *   4. Re-merges overload definitions that share a real method name
 *      (via the caller-supplied `methodNameMap`) into the
 *      `MethodEntry[]` overload form of the `RosettaMap` schema.
 *   5. Applies caller-supplied `classKindMap` for `kind` (sigmatcher
 *      cannot infer this).
 *   6. Annotates every emitted `ClassEntry` with `source: 'sigmatcher'`
 *      so provenance carries through to the downstream map.
 *   7. Validates the assembled object against the locked `RosettaMap`
 *      schema before returning it.
 *
 * Anything sigmatcher cannot infer (`aidl_txn`, `static` flag,
 * `is_constructor`, `synthetic`, `anchors`) is left undefined. Map
 * authors who need those fields layer them in via a hand-authored
 * merge step (Wave 1.5 `rosetta merge`).
 */

import type {
    ClassEntry,
    ClassKind,
    ClassMap,
    FieldEntry,
    FieldMap,
    MethodEntry,
    MethodMap,
    RosettaMap,
} from '../../src/types/map.js';
import { validateMap } from '../../src/validate/index.js';
import { RosettaError } from '../../src/errors.js';

/** Options the caller supplies — sigmatcher itself can't fill these. */
export interface SigmatcherAdapterOptions {
    /** Android package name (e.g. "com.example.testapp"). */
    app: string;
    /** App version *label* (PackageInfo.versionName) this output was captured against. */
    version: string;
    /** Authoritative version code (PackageInfo.versionCode / longVersionCode). */
    versionCode: number;
    /** Optional SHA-256 (hex) of the APK signing certificate. */
    signerSha256?: string;
    /** Optional ISO date when the map was captured. */
    capturedAt?: string;
    /**
     * Map of sigmatcher definition-name → real method name, used to
     * re-merge multiple overload definitions under one real key.
     *
     * Example: `{ requestTicket_2arg: 'requestTicket',
     *             requestTicket_3arg: 'requestTicket' }`.
     *
     * Definitions not appearing here keep their definition name as the
     * real method name.
     */
    methodNameMap?: Record<string, string>;
    /** Map of class real FQN → schema `kind`. Unmapped classes leave `kind` undefined. */
    classKindMap?: Record<string, ClassKind>;
}

// ---------------------------------------------------------------------------
// Raw input shape (subset we depend on)
// ---------------------------------------------------------------------------

interface RawNameWithPackage {
    name?: string;
    package?: string;
}

interface RawMethodSide {
    name?: string;
    argument_types?: string;
    return_type?: string;
}

interface RawMethodMatch {
    original?: RawMethodSide;
    new?: RawMethodSide;
}

interface RawFieldSide {
    name?: string;
    type?: string;
}

interface RawFieldMatch {
    original?: RawFieldSide;
    new?: RawFieldSide;
}

interface RawDefinition {
    original?: RawNameWithPackage;
    new?: RawNameWithPackage;
    matched_methods?: RawMethodMatch[];
    matched_fields?: RawFieldMatch[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Convert sigmatcher's `raw`-format JSON output into a `RosettaMap`.
 *
 * @param raw     Parsed sigmatcher output (the object loaded from the
 *                file `sigmatcher analyze --output-format raw` writes).
 * @param options Caller-supplied metadata + overload-remerging table.
 * @throws RosettaError if `raw` is not a plain object.
 * @throws MapValidationError if the assembled map fails schema validation.
 */
export function sigmatcherRawToRosettaMap(
    raw: unknown,
    options: SigmatcherAdapterOptions,
): RosettaMap {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new RosettaError('sigmatcher raw output must be a JSON object');
    }
    const entries = raw as Record<string, unknown>;

    // Group sigmatcher definitions by their target real class FQN. Each
    // definition contributes either the class shell (when defName ===
    // realClassName) or methods/fields under an existing class. We
    // accumulate everything into a per-class working representation,
    // then collapse to `ClassEntry` at the end.
    const working = new Map<string, ClassWorkingEntry>();

    for (const defName of Object.keys(entries)) {
        const def = entries[defName];
        if (def === null || typeof def !== 'object' || Array.isArray(def)) {
            continue;
        }
        ingestDefinition(defName, def, options, working);
    }

    const classes: ClassMap = {};
    for (const [realFqn, entry] of working) {
        classes[realFqn] = finalizeClass(realFqn, entry, options);
    }

    const map: RosettaMap = {
        schema_version: 2,
        app: options.app,
        version: options.version,
        version_code: options.versionCode,
        classes,
    };
    if (options.capturedAt !== undefined) map.captured_at = options.capturedAt;
    if (options.signerSha256 !== undefined) map.signer_sha256 = options.signerSha256;
    map.sources = [{ tool: 'sigmatcher', classes: Object.keys(classes).length }];

    return validateMap(map);
}

// ---------------------------------------------------------------------------
// Working representation — accumulated before validation
// ---------------------------------------------------------------------------

interface ClassWorkingEntry {
    obfuscated?: string;
    methods: Record<string, MethodEntry[]>;
    fields: FieldMap;
}

function ingestDefinition(
    defName: string,
    raw: object,
    options: SigmatcherAdapterOptions,
    working: Map<string, ClassWorkingEntry>,
): void {
    const def = raw as RawDefinition;
    const originalPkg = def.original?.package ?? '';
    const originalName = def.original?.name ?? '';
    if (!originalPkg || !originalName) {
        // No real-class anchor → can't slot this definition into a
        // class entry. Skip gracefully (sigmatcher occasionally emits
        // partials in --no-progress runs).
        return;
    }
    const realFqn = `${originalPkg}.${originalName}`;
    const wk = ensureWorkingEntry(working, realFqn);

    // If the definition is class-shaped (defName === originalName, no
    // matched_methods/fields focus), it pins the class's obfuscated
    // short name. Multiple definitions can point at the same class —
    // we keep the first non-empty obfuscated name we see; sigmatcher's
    // raw output is consistent enough that this is safe.
    const obfShort = def.new?.name;
    if (obfShort && !wk.obfuscated) {
        wk.obfuscated = obfShort;
    }

    for (const m of def.matched_methods ?? []) {
        const realMethod = options.methodNameMap?.[defName] ?? m.original?.name ?? defName;
        const obfMethod = m.new?.name;
        if (!realMethod || !obfMethod) continue;
        const sig = buildJvmSignature(m.new);
        const entry: MethodEntry = { obfuscated: obfMethod, signature: sig };
        const bucket = (wk.methods[realMethod] ??= []);
        bucket.push(entry);
    }

    for (const f of def.matched_fields ?? []) {
        const realField = f.original?.name;
        const obfField = f.new?.name;
        const fieldType = f.new?.type;
        if (!realField || !obfField || !fieldType) continue;
        const entry: FieldEntry = { obfuscated: obfField, type: fieldType };
        wk.fields[realField] = entry;
    }
}

function ensureWorkingEntry(
    working: Map<string, ClassWorkingEntry>,
    realFqn: string,
): ClassWorkingEntry {
    let wk = working.get(realFqn);
    if (!wk) {
        wk = { methods: {}, fields: {} };
        working.set(realFqn, wk);
    }
    return wk;
}

function buildJvmSignature(side: RawMethodSide | undefined): string {
    const args = side?.argument_types ?? '';
    const ret = side?.return_type ?? '';
    return `(${args})${ret}`;
}

function finalizeClass(
    realFqn: string,
    wk: ClassWorkingEntry,
    options: SigmatcherAdapterOptions,
): ClassEntry {
    if (!wk.obfuscated) {
        throw new RosettaError(
            `sigmatcher adapter: no obfuscated short name resolved for class ${realFqn}`,
        );
    }
    const methods: MethodMap = {};
    for (const [realName, overloads] of Object.entries(wk.methods)) {
        methods[realName] = overloads.length === 1 ? (overloads[0] as MethodEntry) : overloads;
    }
    const entry: ClassEntry = {
        obfuscated: wk.obfuscated,
        source: 'sigmatcher',
    };
    const kind = options.classKindMap?.[realFqn];
    if (kind !== undefined) entry.kind = kind;
    if (Object.keys(methods).length > 0) entry.methods = methods;
    if (Object.keys(wk.fields).length > 0) entry.fields = wk.fields;
    return entry;
}
