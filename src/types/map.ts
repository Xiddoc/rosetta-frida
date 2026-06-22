/**
 * Mapping file types — the on-disk schema, loaded into memory.
 *
 * These are the LOCKED contracts that all Wave 1 agents implement against.
 * Do not change shapes without coordination across agents.
 *
 * The on-disk format is strict JSON (one map per file). The in-memory
 * representation is this structure. (Comment-bearing YAML / TS modules
 * are *authoring inputs* converted to JSON via `rosetta convert`.)
 */

/** Provenance source for a map (or subset of entries). */
export interface MapSource {
    /** Tool name: 'sigmatcher' | 'hand-authored' | 'rosetta-runtime-discovered' | other. */
    tool: string;
    /** Optional config / config-path that produced these entries. */
    config?: string;
    /** Optional count of classes attributed to this source. */
    classes?: number;
}

/**
 * Optional, client-specific hints nested under a map's `client_hints`
 * sub-object. The canonical schema groups per-client metadata here (with its
 * own `additionalProperties: false`) rather than at the top level, so an
 * unknown hint key fails loudly on both clients. Frida reads the
 * `frida_min_version` / `frida_max_version` range; other clients ignore it.
 */
export interface ClientHints {
    /** Minimum Frida version this map is known to work with. */
    frida_min_version?: string;
    /** Maximum Frida version this map is known to work with. */
    frida_max_version?: string;
}

/**
 * Provenance pointer back to the signatures revision a map was generated
 * from (#36). Optional at the map level; when present, `signatures_rev` is
 * required and must be an abbreviated-or-full git commit hash
 * (`^[0-9a-f]{7,40}$`). Lets a consumer trace a published artifact back to
 * the exact `rosetta-maps` signatures commit that produced it.
 */
export interface GeneratedFrom {
    /** Git revision (7–40 lowercase hex) of the signatures that produced this map. */
    signatures_rev: string;
}

/**
 * Lifecycle status of a map (#40). Absent ⇒ `'active'`. A `'superseded'`
 * map still loads but the session emits a warning (it has been replaced by a
 * newer capture, optionally named by `superseded_by`); a `'retracted'` map
 * is refused fail-closed (it was withdrawn — e.g. found to be wrong).
 */
export type MapStatus = 'active' | 'superseded' | 'retracted';

export type ClassKind = 'class' | 'interface' | 'enum' | 'synthetic' | 'anonymous';

/** One method overload. */
export interface MethodEntry {
    /** Obfuscated method name (e.g. "c", "f"). */
    obfuscated: string;
    /**
     * JVM descriptor signature with obfuscated names for class refs.
     * Example: "(Landroid/os/Bundle;Lbbbb;)V"
     * The resolver builds a reverse index for cross-class translation.
     */
    signature: string;
    /** Whether the method is static. */
    static?: boolean;
    /** Whether the method is synthetic (compiler-generated). */
    synthetic?: boolean;
    /** Whether this is a constructor (<init>). */
    is_constructor?: boolean;
}

/** One field on a class. */
export interface FieldEntry {
    /** Obfuscated field name (e.g. "a", "b"). */
    obfuscated: string;
    /**
     * JVM descriptor type. For class refs the descriptor uses the
     * obfuscated name (e.g. "Lbbbb;"). For primitives: "I", "Z", etc.
     */
    type: string;
    /** Whether the field is static. */
    static?: boolean;
}

/**
 * AUTHORING / on-disk method-map shape. A real method name maps to either
 * a single MethodEntry (the common single-overload case — terser to author)
 * or an array of MethodEntry (multiple overloads). This is the shape the
 * Zod validator ACCEPTS; it normalises every value to an array on the way
 * in (see {@link MethodMap}).
 */
export type MethodMapInput = Record<string, MethodEntry | MethodEntry[]>;

/**
 * IN-MEMORY method-map shape. After validation, a method name ALWAYS maps
 * to a (non-empty) array of overloads — the single-entry authoring form is
 * normalised to a one-element array by the validator's `.transform(...)`.
 * Consumers (the resolver, the proxy) therefore never branch on
 * array-vs-single; they always iterate.
 */
export type MethodMap = Record<string, MethodEntry[]>;

/** Fields are keyed by real name. */
export type FieldMap = Record<string, FieldEntry>;

/** One class entry, keyed by its real fully-qualified name. */
export interface ClassEntry {
    /** Obfuscated short name (e.g. "aaaa"). */
    obfuscated: string;
    /**
     * Parent class — either a real name (must also be a key in classes)
     * or an obfuscated name (for parents we don't have a real-name
     * mapping for, like framework helpers).
     */
    extends?: string;
    /** What kind of class this is. */
    kind?: ClassKind;
    /** DEX shard (optional debugging metadata). */
    dex?: string;
    /** Methods keyed by real name. */
    methods?: MethodMap;
    /** Fields keyed by real name. */
    fields?: FieldMap;
    /** Which source contributed this entry (cross-reference into top-level `sources`). */
    source?: string;
}

/** Classes are keyed by real fully-qualified name. */
export type ClassMap = Record<string, ClassEntry>;

/**
 * AUTHORING / on-disk class entry. Identical to {@link ClassEntry} except
 * `methods` is the terser {@link MethodMapInput} (scalar-or-array) shape the
 * validator accepts and normalises. Emitters of the on-disk artifact (the
 * sigmatcher adapter) produce this; the validator's `.transform(...)`
 * narrows it to {@link ClassEntry} on load.
 */
export interface ClassEntryInput extends Omit<ClassEntry, 'methods'> {
    /** Methods keyed by real name, in the scalar-or-array authoring shape. */
    methods?: MethodMapInput;
}

/** AUTHORING / on-disk class-map shape (values are {@link ClassEntryInput}). */
export type ClassMapInput = Record<string, ClassEntryInput>;

/**
 * The current map schema version — the single source of truth.
 *
 * Bump this ONE constant to change the schema version. It drives:
 *   - the `RosettaMap.schema_version` literal type (`typeof` below),
 *   - the Zod gate in `src/validate/schema.ts` (`z.literal(...)`),
 *   - the value emitted by the adapter and `rosetta init`.
 *
 * The matching JSON-artifact / docs literals (`"schema_version": N`) are
 * kept in sync by `scripts/check-schema-version.mjs` (run via
 * `npm run schema-version:fix`; `:check` is wired into `npm run verify`).
 *
 * Declared `const` so its type narrows to the numeric literal (e.g. `5`),
 * which is what `RosettaMap.schema_version` and `z.literal` need.
 */
export const CURRENT_SCHEMA_VERSION = 5;

/** The top-level mapping file. */
export interface RosettaMap {
    /**
     * Mandatory. Bumped on breaking schema changes.
     *
     * `4` (current): makes the published map a PURE real→obfuscated mapping.
     * Removes every finding-evidence / AIDL field that no resolver read —
     * `methodEntry.aidl_txn`, `classEntry.aidl_descriptor`, the
     * `classEntry.anchors` array, and the `aidl_stub` / `aidl_callback` values
     * from the class `kind` enum (so `kind` is now only
     * `class | interface | enum | synthetic | anonymous`). Those belong in the
     * signatures authoring source, never the emitted map. The generic
     * structural fields (`extends`, the remaining `kind` values, `dex`) are
     * retained.
     *
     * `3` (previous): removed the `confidence` field (from `sources` and class
     * entries); tightened `captured_at` to an ISO `YYYY-MM-DD` date; let
     * `signer_sha256` be a single hash OR a non-empty array of hashes
     * (match-any); added the optional `generated_from` provenance pointer and
     * the optional `status` / `superseded_by` lifecycle fields. A
     * `schema_version: 3` map is now rejected and must be re-emitted at `4`.
     */
    schema_version: typeof CURRENT_SCHEMA_VERSION;
    /**
     * Android package name (e.g. "com.example.app").
     *
     * Validated against the dotted-package pattern
     * `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$` (every segment
     * must start with a letter) and capped at 256 chars by the schema (see
     * `src/validate/schema.ts`).
     */
    app: string;
    /**
     * Human-readable version label (e.g. "3.4.5"), from
     * `PackageInfo.versionName`. NOT authoritative for selection — it is
     * a display label that can repeat across builds. Used only as the
     * fuzzy-match fallback key. See RFC 0001 Decision 3.
     */
    version: string;
    /**
     * Authoritative app-identity key — the full Android `longVersionCode`
     * (`(versionCodeMajor << 32) | versionCode`), never masked to its low
     * 32 bits. The primary, O(1) key the runtime selects maps by; monotonic
     * per build. Bounded to `[0, MAX_VERSION_CODE]` (2^53 − 1, the largest
     * value a JS number represents exactly). See RFC 0001 Decision 3.
     */
    version_code: number;
    /**
     * ISO `YYYY-MM-DD` calendar date when the map was captured (#39).
     * Validated as a real date (`format: "date"` semantics) — arbitrary
     * text is rejected.
     */
    captured_at?: string;
    /**
     * Optional authenticity guard — hex SHA-256 of the APK signing
     * certificate (not the APK bytes). Cheap to verify on-device via
     * PackageManager; guards against loading a map for a repackaged or
     * spoofed app. See RFC 0001 Decision 3.
     *
     * EITHER a single 64-lowercase-hex digest (`^[0-9a-f]{64}$`) OR a
     * non-empty array of such digests (#38, #32). When several are listed,
     * the guard matches ANY one of them (a key-rotation lineage may present
     * more than one signer). A malformed digest fails validation early; the
     * session layer additionally normalises + re-validates each at runtime.
     */
    signer_sha256?: string | string[];
    /**
     * Optional provenance pointer back to the signatures revision this map
     * was generated from (#36). When present, `signatures_rev` is required.
     */
    generated_from?: GeneratedFrom;
    /**
     * Optional lifecycle status (#40). Absent ⇒ `'active'`. A `'superseded'`
     * map loads with a warning; a `'retracted'` map is refused fail-closed.
     */
    status?: MapStatus;
    /**
     * Optional `version_code` of the map that supersedes this one (#40).
     * Only meaningful alongside `status: 'superseded'`; a human/tooling
     * pointer to the replacement capture.
     */
    superseded_by?: number;
    /**
     * Optional, client-specific hints nested under their own sub-object
     * (canonical schema groups per-client metadata here, not at the top
     * level). Frida reads the `frida_min_version` / `frida_max_version` range.
     */
    client_hints?: ClientHints;
    /** Provenance — which tools produced which subsets. */
    sources?: MapSource[];
    /** The classes themselves. */
    classes: ClassMap;
}

/**
 * AUTHORING / on-disk map shape — the input the Zod validator ACCEPTS.
 * Identical to {@link RosettaMap} except `classes` uses the terser
 * {@link ClassMapInput} (scalar-or-array method) shape. This is what
 * emitters of the on-disk artifact (the sigmatcher adapter) produce and
 * what `z.input<typeof rosettaMapSchema>` is; the validator normalises it
 * to {@link RosettaMap} (`z.output<...>`) on load.
 */
export interface RosettaMapInput extends Omit<RosettaMap, 'classes'> {
    /** The classes themselves, in the scalar-or-array authoring shape. */
    classes: ClassMapInput;
}

/**
 * Multi-version registry — a map keyed by version_code string, used when
 * several versions are bundled together. The runtime selects the right
 * entry by detected version.
 */
export type RosettaMapRegistry = Record<string, RosettaMap>;
