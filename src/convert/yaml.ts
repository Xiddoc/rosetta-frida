/**
 * YAML → RosettaMap converter.
 *
 * YAML is supported as an authoring format for contributors who prefer it,
 * but JSONC is the canonical on-disk format (per design doc §5.1). This
 * converter takes YAML source and produces an in-memory RosettaMap suitable
 * for further serialization to JSONC via `convertToJsonc`.
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
    return validateStructure(parsed);
}
