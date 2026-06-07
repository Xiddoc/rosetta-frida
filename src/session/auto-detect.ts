/**
 * In-process app/version auto-detection.
 *
 * The only auto-detect path rosetta-frida supports — pure Frida JS, no
 * ADB, no external dependencies, works over frida-server-over-TCP without
 * root. The chain mirrors what a Frida hook would write by hand:
 *
 *   const ActivityThread = Java.use('android.app.ActivityThread');
 *   const app = ActivityThread.currentApplication();
 *   const ctx = app.getApplicationContext();
 *   const pkg = app.getPackageName();
 *   const info = ctx.getPackageManager().getPackageInfo(pkg, 0);
 *   const ver = info.versionName.value;
 *   const code = info.getLongVersionCode();   // API 28+ (else .versionCode)
 *
 * The Java runtime is injected (defaulting to the global `Java`) so this
 * module is unit-testable as a pure function — no MockFrida ceremony
 * needed to validate the chain itself.
 */

import { defaultJavaBridge, type JavaBridge } from '../java-bridge.js';

/**
 * Minimal Frida-shaped Java API surface we depend on. Wider Frida types
 * exist via `@types/frida-gum`; we keep ours narrow so the chain's
 * contract is visible in one place.
 */
export interface AutoDetectJavaApi {
    use(className: string): AutoDetectActivityThreadClass;
}

/** The class wrapper Frida hands back for `android.app.ActivityThread`. */
export interface AutoDetectActivityThreadClass {
    currentApplication(): AutoDetectApplication;
}

/** Application instance — exposes the methods we walk. */
export interface AutoDetectApplication {
    getApplicationContext(): AutoDetectContext;
    getPackageName(): string;
}

/** Context — gives us a PackageManager. */
export interface AutoDetectContext {
    getPackageManager(): AutoDetectPackageManager;
}

/** PackageManager — looks up PackageInfo. */
export interface AutoDetectPackageManager {
    getPackageInfo(packageName: string, flags: number): AutoDetectPackageInfo;
}

/**
 * PackageInfo — `versionName` / `versionCode` are Frida field accessors
 * (`.value`); `getLongVersionCode()` is a method (API 28+).
 */
export interface AutoDetectPackageInfo {
    versionName: { value: string };
    /** API 28+ — preferred. Frida returns the Java `long` as a JS number. */
    getLongVersionCode?: () => number;
    /** Pre-28 fallback — the deprecated int `versionCode` field. */
    versionCode?: { value: number };
}

/** Result of a successful auto-detect. */
export interface DetectedAppVersion {
    /** Detected Android package name. */
    app: string;
    /** Detected version label (PackageInfo.versionName). */
    version: string;
    /**
     * Detected authoritative version code (PackageInfo.getLongVersionCode()
     * on API 28+, else the int `versionCode` field). Undefined when neither
     * is readable (e.g. a non-Android process or a stripped runtime).
     */
    versionCode?: number;
}

/**
 * Run the in-process Java chain and return the detected `(app, version)`.
 *
 * @param javaApi Frida's `Java` namespace. Defaults to the shared
 *   {@link JavaBridge} (which reads the global `Java`). Tests pass a fake
 *   that returns canned classes.
 * @param bridge The {@link JavaBridge} used when `javaApi` is omitted.
 *   Defaults to {@link defaultJavaBridge}. Lets tests drive the
 *   global-fallback path without mutating `globalThis`.
 * @throws Error if the underlying chain fails (class not loaded, the
 *   process isn't an Android app, etc.). The caller decides how to
 *   classify the failure.
 */
export function detectAppAndVersion(
    javaApi?: AutoDetectJavaApi,
    bridge: JavaBridge = defaultJavaBridge,
): DetectedAppVersion {
    if (javaApi === undefined && !bridge.available) {
        throw new Error(
            'rosetta-frida: cannot auto-detect — global Java is unavailable. ' +
                'Pass an explicit `app` and `version` to rosetta.session(...) or attach via Frida.',
        );
    }
    const api: AutoDetectJavaApi = javaApi ?? {
        use: (className) => bridge.use(className) as AutoDetectActivityThreadClass,
    };
    const ActivityThread = api.use('android.app.ActivityThread');
    const application = ActivityThread.currentApplication();
    const context = application.getApplicationContext();
    const app = application.getPackageName();
    const packageInfo = context.getPackageManager().getPackageInfo(app, 0);
    const version = packageInfo.versionName.value;
    const versionCode = readVersionCode(packageInfo);
    return versionCode === undefined ? { app, version } : { app, version, versionCode };
}

/**
 * Read the authoritative version code from a PackageInfo wrapper.
 *
 * Prefers `getLongVersionCode()` (API 28+); on older runtimes — or any
 * runtime where the method is absent or throws — falls back to the
 * deprecated int `versionCode` field. Returns undefined when neither is
 * a finite number (so callers can fall back to versionName matching).
 */
function readVersionCode(packageInfo: AutoDetectPackageInfo): number | undefined {
    let code: number | undefined;
    if (typeof packageInfo.getLongVersionCode === 'function') {
        try {
            // Read the FULL 64-bit longVersionCode
            // (`(versionCodeMajor << 32) | versionCode`) — never masked to its
            // low 32 bits, because apps that set versionCodeMajor legitimately
            // exceed 2^31 and masking would alias distinct releases.
            code = Number(packageInfo.getLongVersionCode());
        } catch {
            code = undefined;
        }
    }
    if (code === undefined && packageInfo.versionCode !== undefined) {
        code = Number(packageInfo.versionCode.value);
    }
    if (code === undefined || !Number.isFinite(code)) {
        return undefined;
    }
    // The value rides through a JS Number, exact only up to
    // Number.MAX_SAFE_INTEGER (2^53 − 1). A longVersionCode beyond that
    // cannot be represented without silent truncation — fail loudly rather
    // than select the wrong (or no) map off a corrupted key.
    if (code > Number.MAX_SAFE_INTEGER) {
        throw new Error(
            `auto-detect: longVersionCode ${String(packageInfo.getLongVersionCode?.())} ` +
                `exceeds Number.MAX_SAFE_INTEGER (${String(Number.MAX_SAFE_INTEGER)}); ` +
                'it cannot be represented as an exact JS number for map selection. ' +
                'Verify that the app reports the correct version_code via PackageManager, ' +
                'or pass the session map with a pre-validated version_code explicitly. ' +
                'If the value is genuinely this large, file an issue at ' +
                'https://github.com/Xiddoc/rosetta-frida/issues.',
        );
    }
    return code;
}
