/**
 * Pure merge engine over an ordered list of {@link RosettaMap}s.
 *
 * ## Conflict policy (deterministic)
 *
 * Inputs are merged LEFT-TO-RIGHT; for any key that appears in more than
 * one input, **last-wins** — a later input overrides an earlier one. This
 * makes the order an explicit, documented precedence (put your highest-trust
 * source last). The fold is recursive:
 *   - top-level scalar identity (`app`, `version`, `version_code`, ...) —
 *     last-wins (an `undefined` optional on a later input never erases a
 *     base value);
 *   - `sources[]` — concatenated in order (provenance is additive);
 *   - `classes[realName]` — merged entry-by-entry: a class present in both
 *     has its `methods` / `fields` unioned (last-wins per real name) and
 *     its scalar fields (`obfuscated`, `extends`, ...) last-wins, again with
 *     `undefined` stripped so an explicit `extends: undefined` can't erase a
 *     base value.
 *
 * `strict` turns a *conflicting* obfuscated name into a hard error: if two
 * inputs map the same real name to DIFFERENT obfuscated names (a class,
 * method overload, or field), merge fails closed rather than silently
 * picking the last. Identical values never conflict.
 *
 * Non-strict last-wins overrides of an obfuscated name are the "silent wrong
 * name corrupts hooks" hazard, so {@link MergeOptions.onOverride} lets a
 * caller observe each one (the CLI prints a stderr notice). The callback is
 * the only outward effect — the engine itself is pure.
 */

import type { ClassEntry, FieldEntry, MethodEntry, RosettaMap } from '../types/map.js';

/** A non-strict last-wins override of an obfuscated name, surfaced to callers. */
export interface ObfOverride {
    /** What kind of entry was overridden. */
    kind: 'class' | 'method' | 'field';
    /** Real name of the overridden entry. */
    name: string;
    /** The obfuscated name that was discarded (the earlier input's). */
    from: string;
    /** The obfuscated name that won (the later input's). */
    to: string;
}

/** Options for {@link mergeMaps}. */
export interface MergeOptions {
    /** Fail on conflicting obfuscated names instead of last-wins. */
    strict?: boolean;
    /**
     * Called for each non-strict last-wins override of an obfuscated name
     * (i.e. when `strict` is false and two inputs disagree). Never called in
     * strict mode (a conflict throws there instead). Pure observability — the
     * engine ignores the return value.
     */
    onOverride?: (override: ObfOverride) => void;
}

/** Raised when strict mode finds two inputs disagreeing on an obfuscated name. */
function conflict(kind: string, realName: string, a: string, b: string): Error {
    return new Error(
        `conflicting obfuscated name for ${kind} '${realName}': '${a}' vs '${b}' ` +
            `(merge without strict mode to take the last input's value)`,
    );
}

/**
 * Reconcile two obfuscated names for one real entry under the conflict
 * policy: identical is a no-op; differing throws in strict mode, otherwise
 * notifies `onOverride`. Returning nothing — the caller already takes the
 * later value as last-wins.
 */
function reconcileObf(
    kind: ObfOverride['kind'],
    name: string,
    from: string,
    to: string,
    opts: MergeOptions,
): void {
    if (from === to) return;
    if (opts.strict) throw conflict(kind, name, from, to);
    opts.onOverride?.({ kind, name, from, to });
}

/** Merge two method-overload arrays for one real name (last-wins by signature). */
function mergeOverloads(
    realName: string,
    base: readonly MethodEntry[],
    next: readonly MethodEntry[],
    opts: MergeOptions,
): MethodEntry[] {
    const out = [...base];
    for (const entry of next) {
        const idx = out.findIndex((e) => e.signature === entry.signature);
        if (idx < 0) {
            out.push(entry);
            continue;
        }
        const existing = out[idx] as MethodEntry;
        reconcileObf('method', realName, existing.obfuscated, entry.obfuscated, opts);
        out[idx] = entry; // last-wins
    }
    return out;
}

/** Merge two method maps (keyed by real name). */
function mergeMethods(
    base: ClassEntry['methods'],
    next: ClassEntry['methods'],
    opts: MergeOptions,
): ClassEntry['methods'] {
    if (!next) return base;
    if (!base) return next;
    const out: NonNullable<ClassEntry['methods']> = { ...base };
    for (const [name, overloads] of Object.entries(next)) {
        const existing = out[name];
        out[name] = existing ? mergeOverloads(name, existing, overloads, opts) : overloads;
    }
    return out;
}

/** Merge two field maps (keyed by real name, last-wins). */
function mergeFields(
    base: ClassEntry['fields'],
    next: ClassEntry['fields'],
    opts: MergeOptions,
): ClassEntry['fields'] {
    if (!next) return base;
    if (!base) return next;
    const out: Record<string, FieldEntry> = { ...base };
    for (const [name, entry] of Object.entries(next)) {
        const existing = out[name];
        if (existing) reconcileObf('field', name, existing.obfuscated, entry.obfuscated, opts);
        out[name] = entry;
    }
    return out;
}

/**
 * Drop `undefined` optional values from a partial so a later input never
 * erases a base value with a hole (an explicit `extends: undefined` must not
 * blank out a base `extends`). Applied to both the top-level scalar identity
 * and the per-class scalar spread.
 */
function stripUndefined<T extends object>(obj: T): Partial<T> {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Merge two class entries for the same real name. */
function mergeClassEntry(
    realName: string,
    base: ClassEntry,
    next: ClassEntry,
    opts: MergeOptions,
): ClassEntry {
    reconcileObf('class', realName, base.obfuscated, next.obfuscated, opts);
    // Pull methods/fields out before stripping; they are merged below and an
    // absent one on `next` must fall back to base, not be re-applied raw.
    const { methods: _m, fields: _f, ...nextScalars } = next;
    void _m;
    void _f;
    return {
        ...base,
        ...stripUndefined(nextScalars), // scalar fields last-wins; holes stripped
        methods: mergeMethods(base.methods, next.methods, opts),
        fields: mergeFields(base.fields, next.fields, opts),
    };
}

/** Fold `next` onto `base`, returning the combined map. */
function mergeOne(base: RosettaMap, next: RosettaMap, opts: MergeOptions): RosettaMap {
    const classes: Record<string, ClassEntry> = { ...base.classes };
    for (const [name, entry] of Object.entries(next.classes)) {
        const existing = classes[name];
        classes[name] = existing ? mergeClassEntry(name, existing, entry, opts) : entry;
    }
    const sources = [...(base.sources ?? []), ...(next.sources ?? [])];
    return {
        ...base,
        ...scalarIdentity(next),
        sources: sources.length > 0 ? sources : undefined,
        classes,
    };
}

/**
 * The last-wins top-level scalar identity carried from a later input
 * (everything except `sources` and `classes`, which are merged specially).
 * `undefined` optionals on `next` are stripped so they don't clobber a value
 * the base set.
 */
function scalarIdentity(next: RosettaMap): Partial<RosettaMap> {
    const { sources: _sources, classes: _classes, ...identity } = next;
    void _sources;
    void _classes;
    return stripUndefined(identity);
}

/**
 * Fold an ordered list of maps left-to-right (last-wins). Callers guarantee
 * at least one input; with one input the fold is the identity.
 *
 * @throws Error if any two inputs disagree on `app` or `version_code`, or —
 *   in strict mode — on an obfuscated name.
 */
export function mergeMaps(maps: readonly RosettaMap[], options: MergeOptions = {}): RosettaMap {
    const [first, ...rest] = maps;
    let acc = first as RosettaMap;
    for (const m of rest) {
        if (m.app !== acc.app) {
            throw new Error(`cannot merge maps for different apps: ${acc.app} vs ${m.app}`);
        }
        if (m.version_code !== acc.version_code) {
            throw new Error(
                `cannot merge maps for different version_code: ` +
                    `${acc.version_code} vs ${m.version_code}`,
            );
        }
        acc = mergeOne(acc, m, options);
    }
    return acc;
}
