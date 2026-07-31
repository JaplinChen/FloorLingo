package io.github.japlinchen.floorlingo.model;

import java.util.List;

/** A single condition evaluated against an event before delivery. */
public record WebhookFilterCondition(String field, String operator, List<String> value) {}
