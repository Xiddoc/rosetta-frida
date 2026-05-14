package com.example.testapp;

/**
 * Error reporting enum.
 *
 * Exercises:
 *   <ul>
 *     <li>{@code kind: enum} — a Java enum, distinct from a plain class</li>
 *     <li>Auto-generated {@code values()} / {@code valueOf(String)} — R8
 *         keeps these per the global enum rule in proguard-rules.pro</li>
 *     <li>Static fields for the enum constants — {@code SUCCESS},
 *         {@code TIMEOUT}, {@code AUTH_FAILED}</li>
 *     <li>Instance method on the enum — {@code getCode()}</li>
 *   </ul>
 */
public enum ErrorCode {
    SUCCESS(0),
    TIMEOUT(1),
    AUTH_FAILED(2);

    private final int code;

    ErrorCode(int code) {
        this.code = code;
    }

    public int getCode() {
        return code;
    }
}
