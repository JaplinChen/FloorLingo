package io.github.japlinchen.floorlingo.model;

/** A WhatsApp Business chat label. Optional fields are {@code null} when absent. */
public record LabelRecord(String id, String name, String color, String colorHex) {}
