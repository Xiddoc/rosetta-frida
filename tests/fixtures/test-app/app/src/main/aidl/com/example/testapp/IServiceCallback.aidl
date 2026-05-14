// AIDL callback the service invokes when an async result is ready.
//
// rosetta-frida treats `IServiceCallback` as `kind: aidl_callback` in
// the generated map.  Two methods, single overload each, so the simple
// MethodEntry form (not the array form) is exercised here.
package com.example.testapp;

import android.os.Bundle;

interface IServiceCallback {
    /** Ticket-ready callback. */
    void onResult(in Bundle result);

    /** Error callback. */
    void onError(int code, String message);
}
