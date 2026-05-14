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
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        debug {
            // Debug build keeps real names — useful for local poking.
            isMinifyEnabled = false
        }
    }

    // R8 reads the applymapping seed via a generated proguard file —
    // we emit a tiny proguard fragment pointing at the chosen seed and
    // include it in the release proguardFiles list.
    applicationVariants.configureEach {
        if (buildType.name == "release") {
            val variant = this
            val seedDir = layout.buildDirectory.dir(
                "intermediates/rosetta-applymapping/${variant.name}"
            )
            val seedTask = tasks.register(
                "writeApplyMapping${variant.name.replaceFirstChar { it.uppercase() }}"
            ) {
                val outDir = seedDir
                val inputSeed = applyMappingFile
                inputs.file(inputSeed)
                outputs.dir(outDir)
                doLast {
                    val dir = outDir.get().asFile
                    dir.mkdirs()
                    val pgFragment = File(dir, "applymapping.pro")
                    pgFragment.writeText(
                        "# Auto-generated: points R8 at the pinned obfuscation seed.\n" +
                            "-applymapping ${inputSeed.absolutePath}\n",
                    )
                }
            }
            // Hook the generated fragment into R8's input list.
            val buildTypeObj = android.buildTypes.getByName("release")
            buildTypeObj.proguardFile(
                seedDir.map { it.file("applymapping.pro").asFile }.get()
            )
            // Make minification depend on the seed-writing task.
            tasks.matching {
                it.name == "minify${variant.name.replaceFirstChar { it.uppercase() }}WithR8"
            }.configureEach {
                dependsOn(seedTask)
            }
        }
    }
}
