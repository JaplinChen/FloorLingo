package io.github.japlinchen.floorlingo.model;

import java.util.List;

/** Paginated payload returned by {@code GET /sessions/:id/messages}. */
public record MessageListResponse(List<MessageRecord> messages, int total) {}
