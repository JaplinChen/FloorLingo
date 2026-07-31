package io.github.japlinchen.floorlingo.model;

/** WhatsApp Business catalog metadata. Optional fields are {@code null} when absent. */
public record CatalogInfo(
    String id,
    String name,
    String description,
    int productCount,
    String url) {}
