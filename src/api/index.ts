/**
 * Public re-exports for the user-facing API surface.
 *
 * Tier 1 (Wave 2F): declarative `hook`, `proceed`, `field`/`setField`.
 * Tier 2 (Wave 2E): Java.use-shaped `use`, `type`.
 * Tier 3 (Wave 2G): session-scoped `createMapApi`, `createEventsApi`.
 */

// Tier 2
export { use } from './use.js';
export type { UseOptions } from './use.js';
export { type } from './type.js';
export type { TypeOptions } from './type.js';

// Tier 1
export { hook } from './hook.js';
export type { HookHandle, HookTarget, HookImpl, HookOptions } from './hook.js';
export { proceed } from './proceed.js';
export { field, setField } from './field.js';
export type { FieldOptions } from './field.js';

// Tier 3
export { createMapApi, type MapApi } from './map.js';
export { createEventsApi, type EventsApi } from './events.js';
