/*
 * Root build script for the rosetta-frida synthetic test app.
 *
 * AGP and Kotlin plugin versions are declared here with `apply false`;
 * the :app module applies them. AGP 8.5.x is paired with Gradle 8.7
 * (see gradle/wrapper/gradle-wrapper.properties).
 */
plugins {
    id("com.android.application") version "8.5.2" apply false
}
