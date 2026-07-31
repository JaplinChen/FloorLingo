package io.github.japlinchen.floorlingo.errors;

/** 404 Not Found. */
public class FloorLingoNotFoundError extends FloorLingoApiError {
    public FloorLingoNotFoundError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
