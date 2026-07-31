package io.github.japlinchen.floorlingo.errors;

/** Base class for every error thrown by the SDK. */
public class FloorLingoError extends RuntimeException {
    public FloorLingoError(String message) {
        super(message);
    }
}
