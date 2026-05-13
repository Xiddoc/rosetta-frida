/**
 * Emit marker-block-wrapped JS text from in-memory maps.
 *
 * The shape is exactly what design §5.5 specifies:
 *
 *   /\*! -----BEGIN ROSETTA MAP----- *\/
 *   /\*! app: com.example.app | version: 1.2.3 | schema: 1 | classes: 47 *\/
 *   const __rosetta_map = { ... pretty-printed JSON ... };
 *   /\*! -----END ROSETTA MAP----- *\/
 *
 * The header metadata line is a `/*! ... *\/` "important" comment so
 * minifiers preserve it. It mirrors the payload's `app`, `version`,
 * `schema_version`, and class count so `rosetta inspect` can run a
 * cheap regex-only scan when it doesn't need the full payload.
 *
 * The payload is `JSON.stringify(map, null, 4)` — pretty-printed JSON
 * with a 4-space indent. JSON is a subset of JS object-literal syntax,
 * so the result is both:
 *   - syntactically valid JS (`const x = <JSON>;` parses), and
 *   - parseable as JSON by `parseMarkerBlock` without an eval.
 *
 * We intentionally do NOT inject comments inside the payload. The JSONC
 * source on disk may have comments, but by the time the map is in
 * memory and we're embedding it, we want a single canonical
 * machine-readable form.
 */

import {
    BEGIN_MARKER,
    BEGIN_REGISTRY,
    END_MARKER,
    END_REGISTRY,
    REGISTRY_VAR_NAME,
    SINGLE_VAR_NAME,
} from './format.js';
import type { RosettaMap, RosettaMapRegistry } from '../types/map.js';

/** Pretty-print indent for the embedded payload. */
const PAYLOAD_INDENT = 4;

/**
 * Format the single-map header line. Includes app, version,
 * schema_version, and class count so inspect tools can shortcut.
 */
function singleHeader(map: RosettaMap): string {
    const classCount = Object.keys(map.classes).length;
    return `/*! app: ${map.app} | version: ${map.version} | schema: ${map.schema_version} | classes: ${classCount} */`;
}

/**
 * Format the registry header line. Includes total versions and total
 * class count summed across versions. Apps are listed if all entries
 * share the same `app`; otherwise we report 'mixed'.
 */
function registryHeader(maps: RosettaMapRegistry): string {
    const versions = Object.keys(maps);
    const apps = new Set<string>();
    let totalClasses = 0;
    for (const v of versions) {
        const m = maps[v];
        // Defensive: skip versions whose payload is absent (shouldn't happen
        // for caller-built registries but keeps emit total-safe).
        if (!m) continue;
        apps.add(m.app);
        totalClasses += Object.keys(m.classes).length;
    }
    const appLabel = apps.size === 1 ? [...apps][0] : 'mixed';
    return `/*! app: ${appLabel} | versions: ${versions.length} | classes: ${totalClasses} */`;
}

/**
 * Emit a single-map marker block. Output is JS source that can be
 * concatenated directly into a frida-compile bundle.
 *
 * @param map the in-memory RosettaMap to embed
 * @returns the wrapped JS source (no trailing newline)
 */
export function emitMarkerBlock(map: RosettaMap): string {
    const header = singleHeader(map);
    const payload = JSON.stringify(map, null, PAYLOAD_INDENT);
    return [
        `/*! ${BEGIN_MARKER} */`,
        header,
        `const ${SINGLE_VAR_NAME} = ${payload};`,
        `/*! ${END_MARKER} */`,
    ].join('\n');
}

/**
 * Emit a multi-version registry marker block. Output is JS source.
 *
 * @param maps the in-memory registry (version → map) to embed
 * @returns the wrapped JS source (no trailing newline)
 */
export function emitMarkerRegistry(maps: RosettaMapRegistry): string {
    const header = registryHeader(maps);
    const payload = JSON.stringify(maps, null, PAYLOAD_INDENT);
    return [
        `/*! ${BEGIN_REGISTRY} */`,
        header,
        `const ${REGISTRY_VAR_NAME} = ${payload};`,
        `/*! ${END_REGISTRY} */`,
    ].join('\n');
}
