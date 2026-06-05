/**
 * Converter module — produces canonical strict JSON from YAML input.
 *
 * Re-exports the underlying converters and the user-facing `convertToJson`
 * entry point. TS/JS-module ingestion was removed (build-time RCE); only
 * the module-refusal recognizer is re-exported.
 */

export { yamlToMap } from './yaml.js';
export { isModuleExtension, refuseModuleInput, MODULE_UNSUPPORTED_MESSAGE } from './ts-module.js';
export { validateStructure } from './validate.js';
export { convertToJson, renderJson, detectFormat } from './json.js';
export type { ConvertFormat } from './json.js';
