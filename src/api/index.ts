/**
 * Public re-exports for the tier-1 user-facing API surface.
 *
 * Wave 2F owns: `hook`, `proceed`, `field`, `setField`. Wave 2E (use,
 * type, map) and Wave 2G (session, events) plug their own re-exports
 * into this file at integration time.
 */

export { hook } from './hook.js';
export type { HookHandle, HookTarget, HookImpl, HookOptions } from './hook.js';
export { proceed } from './proceed.js';
export { field, setField } from './field.js';
export type { FieldOptions } from './field.js';
