/**
 * Vitest global setup. Currently empty — individual test files call
 * `useFridaMock()` from `./frida` when they need the mock.
 *
 * Kept as a file (rather than `setupFiles: []`) so future cross-cutting
 * setup (e.g. structured-event capture) has a stable home.
 */

export {};
