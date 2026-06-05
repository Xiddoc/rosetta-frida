/**
 * `InternalSessionOptions` — the session options plus the test-only Java
 * runtime injection points. Extracted from `session.ts` so the
 * `buildSession` pipeline and the `RosettaSession` value holder can both
 * depend on it without a circular import.
 */

import type { EventBus } from '../log.js';
import type { SessionOptions } from '../types/session.js';
import type { AutoDetectJavaApi } from './auto-detect.js';
import type { HealthCheckJavaApi } from './health-check.js';
import type { SignerJavaApi } from './signer-detect.js';

/**
 * Internal-only extension of `SessionOptions` that lets the session accept
 * injected Java runtimes for tests. The public `SessionOptions` locked
 * contract doesn't expose these.
 */
export interface InternalSessionOptions extends SessionOptions {
    /** Test-only: inject the Java API used by auto-detect. */
    autoDetectJavaApi?: AutoDetectJavaApi;
    /** Test-only: inject the Java API used by the health check. */
    healthCheckJavaApi?: HealthCheckJavaApi;
    /** Test-only: inject the Java API used by the signer-certificate check. */
    signerJavaApi?: SignerJavaApi;
    /**
     * Test-only: provide an explicit EventBus. If omitted, the session
     * creates its own session-local bus.
     */
    events?: EventBus;
}
