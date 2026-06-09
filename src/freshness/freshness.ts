/**
 * Map-freshness (completeness-drift) core — the framework-neutral engine
 * behind `rosetta freshness`.
 *
 * This is the **zero-toolchain, read-only consumer twin** of the maps-side
 * `scripts/check_map_freshness.py` CI check (maps#34). The authoritative
 * detection runs in the `rosetta-maps` repo on every PR; this verb lets a
 * developer who has *vendored* maps into their own project run the IDENTICAL
 * computation locally, with no APK and no network I/O.
 *
 * SHARED ALGORITHM (must match the maps repo EXACTLY — it is the cross-repo
 * contract):
 *
 *   1. Parse `signatures/<app>/signatures.yaml` to the SET of real
 *      fully-qualified class names its class rules claim to find. A rule's FQN
 *      is `<package>.<name>`, with sigmatcher's `$`-nesting carried through
 *      verbatim: a rule `name: 'IRemoteService$Stub'` with
 *      `package: 'com.example.app'` yields the FQN
 *      `com.example.app.IRemoteService$Stub` — exactly the spelling of a map's
 *      `classes` KEY for that class. (No `$`→`.` rewrite.)
 *   2. For each map, take the SET of its `classes` object keys.
 *   3. `missing = ruleFQNs − mapClassKeys`. A non-empty `missing` ⇒ the map is
 *      STALE; the missing FQNs are the rules the map does not yet resolve.
 *
 * ADVISORY BY DESIGN. A stale map is NORMAL and mergeable (a signatures-only
 * change legitimately strands every older map until it is regenerated), so a
 * staleness FINDING never throws. The pure core here simply reports; the only
 * errors it raises are for MALFORMED inputs — a signatures doc that is not a
 * non-empty list of rule mappings, or a map whose `classes` is not an object.
 * The CLI wrapper maps those to a non-zero exit and a staleness finding to
 * exit 0.
 */

import { parse as parseYaml } from 'yaml';
import { RosettaError } from '../errors.js';

/**
 * Raised when an input cannot be parsed into the expected shape — the ONLY
 * thing that should make `rosetta freshness` exit non-zero. A `RosettaError`
 * so the CLI router renders it under the uniform `rosetta freshness:` prefix.
 */
export class FreshnessInputError extends RosettaError {
    constructor(message: string) {
        super(message);
        this.name = 'FreshnessInputError';
    }
}

/** One stale map: the rule FQNs it does not yet resolve. */
export interface FreshnessFinding {
    /** The map's identifying path/key as supplied by the caller. */
    mapPath: string;
    /** The app the map belongs to (its parent directory name). */
    app: string;
    /** The map's version_code (its filename without extension). */
    versionCode: string;
    /** The ruled FQNs missing from this map's `classes`, sorted. */
    missing: string[];
}

/** The outcome of analysing a corpus of vendored maps against signatures. */
export interface FreshnessReport {
    /** One entry per stale map. Fresh maps are not represented. */
    findings: FreshnessFinding[];
    /** How many maps were inspected. */
    mapsChecked: number;
    /** How many apps had a signatures source (set an expectation). */
    appsWithSignatures: number;
}

/** A parsed map paired with the path it came from. */
export interface MapClassKeys {
    /** The path/key the caller identifies this map by. */
    mapPath: string;
    /** The app the map belongs to (its parent directory name). */
    app: string;
    /** The map's version_code (filename without extension). */
    versionCode: string;
    /** The SET of the map's `classes` object keys. */
    classKeys: Set<string>;
}

/**
 * Parse a signatures YAML document into the SET of `<package>.<name>` FQNs its
 * class rules claim. Mirrors the maps repo's `rule_fqns`: the `$`-nesting in a
 * rule `name` is carried through verbatim so the FQN equals the map's
 * `classes` key spelling.
 *
 * @throws FreshnessInputError when the document is not a non-empty list of
 *   rule mappings each carrying a non-empty string `name` and `package` — an
 *   unparseable source-of-truth is real breakage, not drift.
 */
export function ruleFqns(doc: unknown, where: string): Set<string> {
    if (!Array.isArray(doc) || doc.length === 0) {
        throw new FreshnessInputError(
            `${where}: top level must be a non-empty list of rule entries`,
        );
    }
    const fqns = new Set<string>();
    for (let i = 0; i < doc.length; i++) {
        const rule = doc[i] as unknown;
        if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
            throw new FreshnessInputError(`${where}: rule[${i}] must be a mapping`);
        }
        const { name, package: pkg } = rule as { name?: unknown; package?: unknown };
        if (typeof name !== 'string' || name.trim() === '') {
            throw new FreshnessInputError(
                `${where}: rule[${i}] missing required non-empty string 'name'`,
            );
        }
        if (typeof pkg !== 'string' || pkg.trim() === '') {
            throw new FreshnessInputError(
                `${where}: rule[${i}] missing required non-empty string 'package'`,
            );
        }
        fqns.add(`${pkg}.${name}`);
    }
    return fqns;
}

/**
 * Parse a signatures YAML *source string* into its expected-FQN set.
 *
 * @throws FreshnessInputError on a YAML syntax error or a doc that is not the
 *   expected rule-list shape.
 */
export function parseSignatures(source: string, where: string): Set<string> {
    let doc: unknown;
    try {
        doc = parseYaml(source);
    } catch (e) {
        throw new FreshnessInputError(`${where}: could not parse YAML: ${(e as Error).message}`);
    }
    return ruleFqns(doc, where);
}

/**
 * Extract the SET of `classes` keys from a parsed map document. Mirrors the
 * maps repo's `map_class_keys`: a map that is not an object, or whose
 * `classes` is not an object, is the MALFORMED case (the schema validator
 * rejects these too) — separate from staleness.
 *
 * @throws FreshnessInputError when the map shape is wrong.
 */
export function mapClassKeys(doc: unknown, where: string): Set<string> {
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
        throw new FreshnessInputError(`${where}: map is not a JSON object`);
    }
    const classes = (doc as { classes?: unknown }).classes;
    if (typeof classes !== 'object' || classes === null || Array.isArray(classes)) {
        throw new FreshnessInputError(`${where}: map 'classes' is not an object`);
    }
    return new Set(Object.keys(classes));
}

/**
 * Parse a map JSON *source string* into its `classes` key set.
 *
 * @throws FreshnessInputError on a JSON syntax error or a wrong map shape.
 */
export function parseMapClassKeys(source: string, where: string): Set<string> {
    let doc: unknown;
    try {
        doc = JSON.parse(source) as unknown;
    } catch (e) {
        throw new FreshnessInputError(`${where}: could not parse JSON: ${(e as Error).message}`);
    }
    return mapClassKeys(doc, where);
}

/**
 * Pure analysis core: compute the stale maps from already-parsed inputs.
 *
 * `maps` is the list of vendored maps (each with its `classes` key set and the
 * `app` it belongs to); `sigByApp` maps an app to its expected-FQN set. A map
 * is stale when its app HAS signatures and `ruleFQNs − classKeys` is non-empty.
 * No I/O — so tests drive it directly and any caller can reuse it.
 *
 * Findings are sorted by `mapPath` for stable output; each finding's `missing`
 * list is sorted too.
 */
export function analyse(
    maps: readonly MapClassKeys[],
    sigByApp: ReadonlyMap<string, Set<string>>,
): FreshnessReport {
    const findings: FreshnessFinding[] = [];
    const ordered = [...maps].sort((a, b) => a.mapPath.localeCompare(b.mapPath));
    for (const m of ordered) {
        const expected = sigByApp.get(m.app);
        // No signatures for this app — no expectation set; never flagged.
        if (expected === undefined || expected.size === 0) continue;
        const missing = [...expected].filter((fqn) => !m.classKeys.has(fqn)).sort();
        if (missing.length > 0) {
            findings.push({
                mapPath: m.mapPath,
                app: m.app,
                versionCode: m.versionCode,
                missing,
            });
        }
    }
    return {
        findings,
        mapsChecked: maps.length,
        appsWithSignatures: sigByApp.size,
    };
}

/**
 * Render a {@link FreshnessReport} as a human-readable, plain-text report
 * (the CLI prints this). The all-fresh case is a single reassuring line; the
 * stale case lists each map and the rules it does not yet resolve. The wording
 * mirrors the maps-side dashboard so the two read alike.
 */
export function renderReport(report: FreshnessReport): string {
    if (report.findings.length === 0) {
        return (
            `all ${report.mapsChecked} map(s) fresh against the current signatures ` +
            `(${report.appsWithSignatures} app(s) with signatures)`
        );
    }
    const lines: string[] = [];
    lines.push(
        `${report.findings.length} stale map(s) of ${report.mapsChecked} checked ` +
            `(advisory — regenerate when convenient):`,
    );
    for (const f of report.findings) {
        lines.push(`  ${f.mapPath} (${f.app}@${f.versionCode}) — missing ${f.missing.length}:`);
        for (const m of f.missing) lines.push(`    ${m}`);
    }
    return lines.join('\n');
}
