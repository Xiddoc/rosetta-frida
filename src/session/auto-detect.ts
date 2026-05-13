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
 *   const ver = ctx.getPackageManager()
 *                  .getPackageInfo(pkg, 0).versionName.value;
 *
 * The Java runtime is injected (defaulting to the global `Java`) so this
 * module is unit-testable as a pure function — no MockFrida ceremony
 * needed to validate the chain itself.
 */

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

/** PackageInfo — versionName is a Frida field accessor (`.value`). */
export interface AutoDetectPackageInfo {
    versionName: { value: string };
}

/** Result of a successful auto-detect. */
export interface DetectedAppVersion {
    /** Detected Android package name. */
    app: string;
    /** Detected version (PackageInfo.versionName). */
    version: string;
}

/**
 * Run the in-process Java chain and return the detected `(app, version)`.
 *
 * @param javaApi Frida's `Java` namespace. Defaults to the global `Java`.
 *   Tests pass a fake that returns canned classes.
 * @throws Error if the underlying chain fails (class not loaded, the
 *   process isn't an Android app, etc.). The caller decides how to
 *   classify the failure.
 */
export function detectAppAndVersion(javaApi?: AutoDetectJavaApi): DetectedAppVersion {
    const api: AutoDetectJavaApi | undefined =
        javaApi ?? (globalThis as unknown as { Java?: AutoDetectJavaApi }).Java;
    if (!api) {
        throw new Error(
            'rosetta-frida: cannot auto-detect — global Java is unavailable. ' +
                'Pass an explicit `app` and `version` to rosetta.session(...) or attach via Frida.',
        );
    }
    const ActivityThread = api.use('android.app.ActivityThread');
    const application = ActivityThread.currentApplication();
    const context = application.getApplicationContext();
    const app = application.getPackageName();
    const packageInfo = context.getPackageManager().getPackageInfo(app, 0);
    const version = packageInfo.versionName.value;
    return { app, version };
}
