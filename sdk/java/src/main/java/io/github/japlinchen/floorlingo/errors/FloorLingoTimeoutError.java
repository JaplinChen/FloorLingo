package io.github.japlinchen.floorlingo.errors;

/** Thrown when a request exceeds the configured timeout. */
public class FloorLingoTimeoutError extends FloorLingoError {
    public FloorLingoTimeoutError(long timeoutMs) {
        super("Request timed out after " + timeoutMs + "ms");
    }
}
