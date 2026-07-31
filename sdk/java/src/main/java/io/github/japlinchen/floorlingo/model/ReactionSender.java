package io.github.japlinchen.floorlingo.model;

/** One reactor and their emoji. {@code timestamp} is a Unix timestamp in seconds. */
public record ReactionSender(String senderId, String emoji, long timestamp) {}
