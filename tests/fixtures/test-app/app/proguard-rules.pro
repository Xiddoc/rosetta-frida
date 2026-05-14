# ──────────────────────────────────────────────────────────────────────
# proguard-rules.pro — R8 rules for the rosetta-frida synthetic test app.
#
# The goal is REALISTIC obfuscation, not "keep everything readable":
#   * Class names rotate (everything in com.example.testapp.* is fair
#     game for renaming).
#   * Method/field names within those classes rotate too.
#   * AIDL stub structure (the binder descriptor field + onTransact
#     dispatch) stays intact because the AIDL contract is a runtime
#     anchor we never want to break.
#   * Enum + inner class shape survives so reflection-based discovery
#     can still find them.
#
# The `-applymapping` directive comes from a generated fragment under
# build/intermediates/rosetta-applymapping/<variant>/applymapping.pro
# (see app/build.gradle.kts).  Two seeds live under app/seeds/ — one
# per fixture version.
# ──────────────────────────────────────────────────────────────────────

# ── Attributes ────────────────────────────────────────────────────────
# Keep enough metadata that:
#   * Java generic signatures survive (so reflection still works).
#   * Inner-class / enclosing-method links stay intact (so the enum +
#     the inner Companion class keep their shape).
#   * Annotations on AIDL-generated code stay readable.
-keepattributes Signature, InnerClasses, EnclosingMethod, *Annotation*, Exceptions

# ── AIDL stub anchors ─────────────────────────────────────────────────
# R8 may freely rename the IMPLEMENTING class (RemoteService) — that
# rotation is exactly what rosetta-frida exists to handle.  But the
# AIDL contract surface (the abstract Stub class + the descriptor
# constant + onTransact) must stay because the binder runtime resolves
# it by name across IPC boundaries.
-keep class com.example.testapp.IRemoteService { *; }
-keep class com.example.testapp.IRemoteService$Stub {
    public static final java.lang.String DESCRIPTOR;
    public boolean onTransact(int, android.os.Parcel, android.os.Parcel, int);
    public static com.example.testapp.IRemoteService asInterface(android.os.IBinder);
}
-keep class com.example.testapp.IServiceCallback { *; }
-keep class com.example.testapp.IServiceCallback$Stub { *; }

# ── Service registration anchors ──────────────────────────────────────
# AndroidManifest names the Service entry point, so its class name
# must survive obfuscation (otherwise the manifest reference dangles).
-keep public class com.example.testapp.RemoteService

# ── Enum shape ───────────────────────────────────────────────────────
# Standard Android enum rule — keeps values()/valueOf() so reflection
# and annotation processors still work, but allows R8 to rename
# constants in non-reflective call sites.
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# ── Stable string anchors ─────────────────────────────────────────────
# The classes that hold "rosetta-test-anchor-*" strings must keep
# those literals so sigmatcher / rosetta-frida discovery can find
# them at runtime.  We don't keep the CLASS name — only the literal
# value gets preserved by R8 when it's referenced via getstatic.
# (R8's default behavior already preserves string constants used in
# code paths that aren't dead-stripped; this rule is documentation.)

# ── Reflection-safe value class ───────────────────────────────────────
# Ticket is reflectively instantiated via Ticket.fromBytes(byte[]) in
# unit tests.  Keep its public-API entry points; the rest can rotate.
-keepclassmembers class com.example.testapp.Ticket {
    public static com.example.testapp.Ticket fromBytes(byte[]);
}

# ── Suppress R8 noise ─────────────────────────────────────────────────
-dontwarn java.lang.invoke.**
-dontwarn org.jetbrains.annotations.**
