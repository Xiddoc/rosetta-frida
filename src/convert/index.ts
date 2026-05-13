/**
 * Converter module — produces canonical JSONC from YAML or TS module input.
 *
 * Re-exports the underlying converters and the user-facing `convertToJsonc`
 * entry point.
 */

export { yamlToMap } from './yaml.js';
export { tsModuleToMap } from './ts-module.js';
export { validateStructure } from './validate.js';
export { convertToJsonc, renderJsonc, detectFormat } from './jsonc.js';
export type { ConvertFormat } from './jsonc.js';
