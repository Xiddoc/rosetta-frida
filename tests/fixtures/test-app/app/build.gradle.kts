/*
 * App module — the synthetic test app whose obfuscated APK exercises
 * every RosettaMap schema feature.
 *
 * Two builds come out of one source tree:
 *
 *   ./gradlew :app:assembleRelease -PapplyMapping=v1.0.0
 *   ./gradlew :app:assembleRelease -PapplyMapping=v1.1.0
 *
 * The `applyMapping` property selects which seeds/<version>.applymapping.txt
 * file R8 reads to deterministically pin obfuscated names.  Identical
 * Java source + different seed = two APKs whose real-name surface is
 * the same but whose obfuscated surface rotates — exactly the cross-
 * version pain rosetta-frida is built to fix.
 */
import java.io.File

plugins {
    id("com.android.application")
}

// Which applymapping seed R8 reads.  Default v1.0.0 so a bare
// `./gradlew :app:assembleRelease` still produces a working APK.
val applyMappingVersion: String = (project.findProperty("applyMapping") as String?) ?: "v1.0.0"
val applyMappingFile: File = file("seeds/${applyMappingVersion}.applymapping.txt")
require(applyMappingFile.exists()) {
    "applymapping seed not found: ${applyMappingFile.absolutePath}. " +
        "Available seeds: ${file("seeds").list()?.joinToString(", ")}"
}

android {
    namespace = "com.example.testapp"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.example.testapp"
        minSdk = 21
        targetSdk = 34
        // The applyMapping version drives the APK versionName so the
        // running app's PackageManager surfaces the right rosetta-frida
        // (app, version) tuple.  v1.0.0 → "1.0.0", v1.1.0 → "1.1.0".
        versionCode = if (applyMappingVersion == "v1.1.0") 2 else 1
        versionName = applyMappingVersion.removePrefix("v")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        aidl = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = false

            // Point R8 at the pinned obfuscation seed via a tiny generated
            // proguard fragment. It is written EAGERLY here (configuration
            // time), NOT as a task output: if it were a task output, the
            // tasks that read the proguardFiles list (R8, the lint-vital
            // model writer, …) would have an undeclared implicit dependency
            // on it, which Gradle 8.7 rejects as a validation error.
            val applyMappingFragment =
                layout.buildDirectory
                    .file("intermediates/rosetta-applymapping/applymapping.pro")
                    .get()
                    .asFile
            applyMappingFragment.parentFile.mkdirs()
            applyMappingFragment.writeText(
                "# Auto-generated: points R8 at the pinned obfuscation seed.\n" +
                    "-applymapping ${applyMappingFile.absolutePath}\n",
            )

            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
                applyMappingFragment,
            )
        }
        debug {
            // Debug build keeps real names — useful for local poking.
            isMinifyEnabled = false
        }
    }
}
