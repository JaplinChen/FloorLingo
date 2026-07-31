package io.github.japlinchen.floorlingo.errors;

/** 429 Too Many Requests — rate limited. */
public class FloorLingoRateLimitError extends FloorLingoApiError {
    public FloorLingoRateLimitError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
