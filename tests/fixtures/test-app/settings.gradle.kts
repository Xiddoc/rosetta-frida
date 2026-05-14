/*
 * Root settings for the rosetta-frida synthetic test app.
 *
 * This fixture produces two deterministically-obfuscated APKs (v1.0.0 and
 * v1.1.0) from IDENTICAL Java source by varying R8 `-applymapping` seeds
 * at build time. See README.md for the build flow.
 */
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "rosetta-test-app"
include(":app")
