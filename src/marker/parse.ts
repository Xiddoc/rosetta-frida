/**
 * Parse a marker-block out of a compiled bundle.
 *
 * Three responsibilities:
 *   1. Locate the marker block (either single-map or registry form).
 *   2. Extract the JS-literal payload between the markers.
 *   3. Parse the payload as JSON and return a typed result.
 *
 * Safety:
 *   - We do NOT `eval` or `Function()` the payload. `emitMarkerBlock`
 *     uses `JSON.stringify(...)` to produce the payload, and JSON is a
 *     strict subset of JS object literals — so the inverse via
 *     `JSON.parse` is exact, safe, and round-trip-correct.
 *   - For any caller that embeds non-JSON literals (e.g. arrow
 *     functions, unquoted keys, comments) we will throw a
 *     MarkerBlockError. That's intentional: rosetta-frida's contract
 *     is "emit produces parseable JSON in the payload."
 *
 * Errors all throw `MarkerBlockError`. The cases:
 *   - No BEGIN marker found.
 *   - BEGIN found but no matching END marker (unterminated).
 *   - Payload doesn't have the expected `const __rosetta_map[s] = ...;`
 *     shape.
 *   - Payload object literal isn't valid JSON.
 */

import { MarkerBlockError } from '../errors.js';
import {
    BEGIN_MARKER,
    BEGIN_REGISTRY,
    END_MARKER,
    END_REGISTRY,
    REGISTRY_VAR_NAME,
    SINGLE_VAR_NAME,
} from './format.js';
import type { RosettaMap, RosettaMapRegistry } from '../types/map.js';

/** Result of a successful single-map parse. */
export interface ParsedSingle {
    kind: 'single';
    map: RosettaMap;
    /** [startIndex, endIndex) — the range of the entire block in the source. */
    range: [number, number];
}

/** Result of a successful registry parse. */
export interface ParsedRegistry {
    kind: 'registry';
    maps: RosettaMapRegistry;
    /** [startIndex, endIndex) — the range of the entire block in the source. */
    range: [number, number];
}

/** Union of parse outcomes. */
export type ParsedMarker = ParsedSingle | ParsedRegistry;

/**
 * Locate the marker block in `bundleText` and return its boundaries.
 *
 * The boundary search keys on `BEGIN_MARKER` / `BEGIN_REGISTRY` as
 * literal substrings — we extend left to the opening `/*!` so the
 * "range" we return covers the whole comment wrapper, not just the
 * marker text inside it. Same on the right edge.
 *
 * @returns the kind and the [startIndex, endIndexExclusive] block range
 */
function locate(
    bundleText: string,
): { kind: 'single' | 'registry'; range: [number, number] } | null {
    // BEGIN_MARKER and BEGIN_REGISTRY are distinct strings (the dashes
    // immediately follow `MAP` for single, and `REGISTRY` intervenes for
    // registry) — so a registry-only bundle has `sglBegin === -1`. We
    // pick whichever marker is present; if both are present (an unusual
    // mixed bundle) the earlier one wins.
    const regBegin = bundleText.indexOf(BEGIN_REGISTRY);
    const sglBegin = bundleText.indexOf(BEGIN_MARKER);

    let beginIdx: number;
    let kind: 'single' | 'registry';
    let endMarker: string;

    const preferRegistry = regBegin !== -1 && (sglBegin === -1 || regBegin <= sglBegin);
    if (preferRegistry) {
        beginIdx = regBegin;
        kind = 'registry';
        endMarker = END_REGISTRY;
    } else if (sglBegin !== -1) {
        beginIdx = sglBegin;
        kind = 'single';
        endMarker = END_MARKER;
    } else {
        return null;
    }

    const endMarkerIdx = bundleText.indexOf(endMarker, beginIdx);
    if (endMarkerIdx === -1) {
        return null;
    }

    // Walk left from beginIdx to include the opening `/*!` comment, if
    // present (it is, in well-formed output). Stop at most a few chars
    // back; if not found, fall back to the marker start.
    const openCommentIdx = bundleText.lastIndexOf('/*!', beginIdx);
    // Only accept a `/*!` within a small window — it must immediately
    // precede the marker (separated by at most a single space).
    const start =
        openCommentIdx !== -1 && beginIdx - openCommentIdx <= 5 ? openCommentIdx : beginIdx;

    // Walk right from endMarkerIdx to include the closing `*/`, if
    // present. The expected pattern is `<endMarker> */`.
    const closeCommentIdx = bundleText.indexOf('*/', endMarkerIdx);
    const endOfBlock =
        closeCommentIdx !== -1 && closeCommentIdx - endMarkerIdx <= endMarker.length + 5
            ? closeCommentIdx + 2
            : endMarkerIdx + endMarker.length;

    return { kind, range: [start, endOfBlock] };
}

/**
 * Extract the JSON object literal between the BEGIN and END markers.
 *
 * The expected payload shape is:
 *   const __rosetta_map = { ... };
 * (or `__rosetta_maps` for a registry). We locate the `=` after the
 * expected variable name, then take everything up to the final `;`
 * before the END marker.
 */
function extractPayload(
    bundleText: string,
    range: [number, number],
    kind: 'single' | 'registry',
    endMarker: string,
): string {
    const [start, end] = range;
    const block = bundleText.slice(start, end);
    const varName = kind === 'single' ? SINGLE_VAR_NAME : REGISTRY_VAR_NAME;

    // Find `const <varName>`. We accept `const`, `let`, or `var` to be
    // forgiving with V2+ placeholder forms — but the JSON payload must
    // still follow.
    const declRegex = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*`);
    const declMatch = declRegex.exec(block);
    if (!declMatch) {
        throw new MarkerBlockError(
            `marker block found but no \`${varName} = ...\` declaration inside`,
        );
    }
    const payloadStart = declMatch.index + declMatch[0].length;

    // The END marker sits at a known offset within `block` — `range`
    // was computed to bracket it. Walk back from there to the last `;`
    // before the END marker; that's where the payload terminates.
    const endMarkerLocal = block.lastIndexOf(endMarker);
    // Walk back to the last `;` between declaration and end-marker.
    const lastSemi = block.lastIndexOf(';', endMarkerLocal);
    if (lastSemi === -1 || lastSemi < payloadStart) {
        throw new MarkerBlockError(
            `marker block payload doesn't terminate with a \`;\` before the END marker`,
        );
    }

    return block.slice(payloadStart, lastSemi).trim();
}

/**
 * Parse the marker block embedded in `bundleText`.
 *
 * @throws MarkerBlockError on missing or malformed marker.
 */
export function parseMarkerBlock(bundleText: string): ParsedMarker {
    const located = locate(bundleText);
    if (!located) {
        throw new MarkerBlockError('no rosetta-frida marker block found in bundle');
    }

    const endMarker = located.kind === 'single' ? END_MARKER : END_REGISTRY;
    const literal = extractPayload(bundleText, located.range, located.kind, endMarker);

    let parsed: unknown;
    try {
        parsed = JSON.parse(literal);
    } catch (err) {
        // `JSON.parse` only ever throws SyntaxError (an Error subclass),
        // so `.message` is always available; no `String(err)` fallback
        // needed.
        const reason = (err as Error).message;
        throw new MarkerBlockError(`marker block payload is not valid JSON: ${reason}`);
    }

    if (located.kind === 'single') {
        return { kind: 'single', map: parsed as RosettaMap, range: located.range };
    }
    return { kind: 'registry', maps: parsed as RosettaMapRegistry, range: located.range };
}
