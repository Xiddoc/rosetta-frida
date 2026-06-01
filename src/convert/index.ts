/**
 * Converter module — produces canonical strict JSON from YAML or TS module input.
 *
 * Re-exports the underlying converters and the user-facing `convertToJson`
 * entry point.
 */

export { yamlToMap } from './yaml.js';
export { tsModuleToMap } from './ts-module.js';
export { validateStructure } from './validate.js';
export { convertToJson, renderJson, detectFormat } from './json.js';
export type { ConvertFormat } from './json.js';
