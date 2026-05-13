/**
 * Public surface of the session subsystem.
 */

export {
    RosettaSession,
    createSession,
    isRegistry,
    type InternalSessionOptions,
} from './session.js';
export {
    detectAppAndVersion,
    type AutoDetectJavaApi,
    type AutoDetectActivityThreadClass,
    type AutoDetectApplication,
    type AutoDetectContext,
    type AutoDetectPackageManager,
    type AutoDetectPackageInfo,
    type DetectedAppVersion,
} from './auto-detect.js';
export { pickMapForVersion, type PickedMap, type PickMapOptions } from './version-match.js';
export {
    runHealthCheck,
    DEFAULT_HEALTH_CHECK_THRESHOLD,
    type HealthCheckJavaApi,
    type HealthCheckResult,
    type RunHealthCheckOptions,
} from './health-check.js';
