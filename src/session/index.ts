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
export {
    pickMapForVersion,
    type PickedMap,
    type PickMapOptions,
    type RankedCandidate,
} from './version-match.js';
export {
    runHealthCheck,
    DEFAULT_HEALTH_CHECK_THRESHOLD,
    type HealthCheckJavaApi,
    type HealthCheckResult,
    type RunHealthCheckOptions,
} from './health-check.js';
export {
    detectSigners,
    checkSigner,
    normalizeSignerHash,
    NoSignerReadableError,
    HEX_64,
    GET_SIGNING_CERTIFICATES,
    GET_SIGNATURES,
    type SignerJavaApi,
    type SignerActivityThreadClass,
    type SignerApplication,
    type SignerContext,
    type SignerPackageManager,
    type SignerPackageInfo,
    type SignerSignature,
    type SignerByteArray,
    type SignerSigningInfo,
    type SignerMessageDigest,
    type SignerMessageDigestClass,
    type DetectedSigners,
    type SignerCheckResult,
} from './signer-detect.js';
