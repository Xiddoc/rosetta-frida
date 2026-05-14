package com.example.testapp;

import java.nio.charset.StandardCharsets;

/**
 * Ticket value object.
 *
 * Exercises:
 *   <ul>
 *     <li>{@code kind: class} — plain Java class</li>
 *     <li>Multiple constructors — modeled in the schema as multi-
 *         overload methods on the "&lt;init&gt;" key with
 *         {@code is_constructor: true}</li>
 *     <li>Static factory method — {@code fromBytes(byte[])}</li>
 *     <li>{@code kind: synthetic} — the inner {@link Companion} class
 *         is the Java analogue of a Kotlin companion: a nested helper
 *         that R8 typically marks synthetic via its access flags</li>
 *     <li>Cross-class reference — {@link Companion#create(String)}
 *         returns a {@link Ticket}, so the signature references this
 *         outer class</li>
 *   </ul>
 */
public class Ticket {

    private final String value;
    private final long expiryMillis;

    /** Constructor overload 1 — no expiry. */
    public Ticket(String value) {
        this(value, Long.MAX_VALUE);
    }

    /** Constructor overload 2 — explicit expiry. */
    public Ticket(String value, long expiryMillis) {
        this.value = value;
        this.expiryMillis = expiryMillis;
    }

    /** Static factory — exercises a non-constructor static method. */
    public static Ticket fromBytes(byte[] bytes) {
        return new Ticket(new String(bytes, StandardCharsets.UTF_8));
    }

    public String getValue() {
        return value;
    }

    public long getExpiry() {
        return expiryMillis;
    }

    /**
     * Inner instance class that touches the OUTER's private fields.
     *
     * Because it's a non-static inner class accessing private members of
     * the enclosing {@link Ticket}, javac emits synthetic accessor methods
     * ({@code access$000}, {@code access$100}, ...) on the outer class.
     * Those synthetic accessors are exactly the {@code kind: synthetic}
     * shape rosetta-frida's schema represents.
     */
    public final class Reader {
        /** Reads the outer's private value via a javac-emitted accessor. */
        public String readValue() {
            return Ticket.this.value;
        }

        /** Reads the outer's private expiry via a second accessor. */
        public long readExpiry() {
            return Ticket.this.expiryMillis;
        }
    }

    /**
     * Static nested helper.  R8 keeps the InnerClasses attribute (per
     * proguard-rules.pro) so this remains identifiable as an inner
     * class of {@link Ticket}.  Stand-in for a Kotlin-style {@code Companion}.
     */
    public static final class Companion {
        /**
         * Cross-class return type — exercises the resolver's reverse
         * index for signatures that reference other mapped classes.
         */
        public static Ticket create(String value) {
            return new Ticket(value);
        }
    }
}
