/**
 * TypeScript-module → RosettaMap converter.
 *
 * Power users can author maps as TS modules that default-export (or named-
 * export as `map`) a RosettaMap object. This gives them compile-time type
 * checking. At conversion time we dynamically import the module and pull
 * the exported map out.
 *
 * IMPORTANT: this uses dynamic `import()`. The caller is responsible for
 * providing a path that the runtime can resolve. For Node usage, callers
 * typically pass an absolute path or a `file://` URL.
 */

import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { RosettaError } from '../errors.js';
import type { RosettaMap } from '../types/map.js';
import { validateStructure } from './validate.js';

interface MaybeMapModule {
    default?: unknown;
    map?: unknown;
}

/**
 * Dynamically import the TS/JS module at `modulePath` and validate the
 * exported RosettaMap. Looks for `default` export first; falls back to
 * a named `map` export.
 *
 * @throws RosettaError if the module can't be loaded or exposes no map.
 * @throws MapValidationError if the exported map fails validation.
 */
export async function tsModuleToMap(modulePath: string): Promise<RosettaMap> {
    const url = toFileUrl(modulePath);
    let mod: MaybeMapModule;
    try {
        mod = (await import(url)) as MaybeMapModule;
    } catch (e) {
        throw new RosettaError(`failed to load TS module '${modulePath}': ${(e as Error).message}`);
    }
    const exported = mod.default ?? mod.map;
    if (exported === undefined) {
        throw new RosettaError(
            `module '${modulePath}' has no \`default\` or \`map\` export — ` +
                'expected a RosettaMap',
        );
    }
    return validateStructure(exported);
}

/**
 * Convert a filesystem path (absolute or relative) to a file:// URL that
 * Node's dynamic `import()` can resolve. If the input is already a URL,
 * pass it through unchanged.
 */
function toFileUrl(modulePath: string): string {
    if (modulePath.startsWith('file://') || /^https?:\/\//.test(modulePath)) {
        return modulePath;
    }
    const abs = isAbsolute(modulePath) ? modulePath : resolvePath(modulePath);
    return pathToFileURL(abs).href;
}
