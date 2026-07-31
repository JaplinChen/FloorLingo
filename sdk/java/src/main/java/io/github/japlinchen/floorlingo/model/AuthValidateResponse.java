package io.github.japlinchen.floorlingo.model;

/** Result of validating the configured API key. */
public record AuthValidateResponse(boolean valid, String role) {}
