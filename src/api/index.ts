/**
 * Public surface of the Tier 1/2/3 API. Each Wave 2 agent contributes
 * their own piece — this barrel is shared so consumers have a single
 * import root.
 *
 * Wave 2G (this commit): Tier 3 `map` and `events` surfaces.
 */

export { createMapApi, type MapApi } from './map.js';
export { createEventsApi, type EventsApi } from './events.js';
