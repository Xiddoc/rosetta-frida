// AIDL contract for the synthetic test app's binder service.
//
// `IRemoteService` is the descriptor; AIDL-compiler emits a static
// nested `Stub` class that R8 may not rename (see proguard-rules.pro).
// rosetta-frida treats `IRemoteService$Stub` as `kind: aidl_stub` in
// the generated map.
//
// NOTE: AIDL interface methods must have UNIQUE names — AIDL does not
// support method overloading. The multi-overload form of the
// MethodEntry schema is exercised instead by `BlobCache.put`
// (`put_2arg` / `put_3arg`), a plain class where overloading is legal.
package com.example.testapp;

import android.os.Bundle;
import com.example.testapp.IServiceCallback;

interface IRemoteService {
    /** The common request path. */
    void requestTicket(in Bundle params, IServiceCallback callback);

    /** Cross-class reference: returns a String, but the SIGNATURE refers
     *  to com.example.testapp.IServiceCallback as one of its parameter
     *  types — exercising the "method signature references another mapped
     *  class" feature.
     */
    String requestPrompt(in Bundle params, IServiceCallback callback);
}
