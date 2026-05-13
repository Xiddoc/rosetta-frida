/**
 * Tier-2 API surface re-exports.
 *
 * `use(realName, { resolver })` and `type(realName, { resolver })` are
 * the Java.use-shaped entry points. Other Wave 2 agents contribute the
 * declarative Tier-1 (`hook`, `proceed`, `field`) and Tier-3
 * (`map`, `events`) surfaces in adjacent files under this directory.
 */

export { use } from './use.js';
export type { UseOptions } from './use.js';
export { type } from './type.js';
export type { TypeOptions } from './type.js';
