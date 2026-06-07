/**
 * YAML → RosettaMap converter.
 *
 * YAML is supported as an authoring format for contributors who prefer it,
 * but strict JSON is the canonical on-disk format (per design doc §5.1).
 * This converter takes YAML source and produces an in-memory RosettaMap
 * suitable for further serialization to JSON via `convertToJson`.
 *
 * Uses the `yaml` package (eemeli/yaml) — zero-dep, MIT, well-typed.
 *
 * Validation strategy: until Agent A's full Zod validator lands at
 * `src/validate/`, we perform a structural check here (schema_version,
 * required top-level fields, classes shape). When the full validator
 * arrives, integration should replace `validateStructure(...)` with a
 * call into it.
 */

import { parse as parseYaml } from 'yaml';
import { MapValidationError, RosettaError } from '../errors.js';
import type { RosettaMap } from '../types/map.js';
import { validateStructure } from './validate.js';
import { normalizeSignerHash } from '../session/signer-detect.js';

/**
 * Canonicalize a parsed-but-unvalidated map's `signer_sha256` IN PLACE for
 * the EMIT boundary (maps#11).
 *
 * Authors hand-write a map's signer hash in whatever form their tooling
 * produced — `keytool` / `apksigner` emit uppercase, colon-separated digests
 * (`AB:CD:…`). The canonical on-disk form is lowercase hex with NO colons
 * (`^[0-9a-f]{64}$`), which the strict schema enforces. Without this step a
 * perfectly authentic colon/uppercase hash would FAIL validation on the way
 * out, so `rosetta convert` could never emit a map carrying it.
 *
 * We normalize with the SAME {@link normalizeSignerHash} the runtime applies
 * to the live cert hash (trim surrounding whitespace, strip `:`, lowercase),
 * then hand the value to the validator. A genuinely malformed hash (wrong
 * length, non-hex, interior whitespace) survives normalization unchanged into
 * the schema's `^[0-9a-f]{64}$` check and is still rejected there — this step
 * only canonicalizes case/colon noise, it does not launder garbage.
 *
 * Mutates only this authoring/emit path; the runtime load path
 * (`loadMap` → `validateMap`) never normalizes the artifact, so an already
 * on-disk map is validated verbatim.
 *
 * Coverage note (review): YAML is the ONLY authoring/emit path that ingests
 * a map body, so this is the only place signer canonicalization is needed.
 * The TS/JS-module convert path (`src/convert/ts-module.ts`) no longer
 * accepts a map at all — it was removed for build-time-RCE safety and now
 * only refuses module inputs (`refuseModuleInput`) — so there is no
 * signer_sha256 to canonicalize there.
 */
function canonicalizeSignerSha256(parsed: unknown): void {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;
    if (typeof record.signer_sha256 === 'string') {
        record.signer_sha256 = normalizeSignerHash(record.signer_sha256);
    }
}

/**
 * Parse YAML source and return a validated RosettaMap.
 *
 * Any error thrown by the underlying YAML parser is wrapped in a
 * `RosettaError`. Empty/null documents and structurally invalid maps
 * surface as `MapValidationError` so the CLI's failure reporting can
 * cite specific issues.
 *
 * @throws RosettaError if YAML parse fails.
 * @throws MapValidationError if the parsed object doesn't conform.
 */
export function yamlToMap(yamlSource: string): RosettaMap {
    let parsed: unknown;
    try {
        parsed = parseYaml(yamlSource);
    } catch (e) {
        throw new RosettaError(`YAML parse error: ${(e as Error).message}`);
    }
    if (parsed === null || parsed === undefined) {
        throw new MapValidationError('YAML source produced an empty document', [
            { path: '', message: 'document is null or empty' },
        ]);
    }
    // Canonicalize the signer hash (case/colon noise) BEFORE validating so a
    // map authored with an apksigner-style `AB:CD:…` digest emits a
    // schema-valid lowercase-no-colon artifact (maps#11).
    canonicalizeSignerSha256(parsed);
    return validateStructure(parsed);
}
