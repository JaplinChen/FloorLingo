package io.github.japlinchen.floorlingo.resources;

import static io.github.japlinchen.floorlingo.http.Http.encodeSegment;

import io.github.japlinchen.floorlingo.FloorLingoClient;
import io.github.japlinchen.floorlingo.http.HttpMethod;
import io.github.japlinchen.floorlingo.model.AddLabelRequest;
import io.github.japlinchen.floorlingo.model.LabelRecord;
import io.github.japlinchen.floorlingo.model.SuccessResult;
import java.util.List;

/**
 * Labels resource — WhatsApp Business chat labels.
 *
 * <p>Labels are a WhatsApp Business feature; the session must be a business account.
 */
public final class LabelsResource {
    private final FloorLingoClient client;

    public LabelsResource(FloorLingoClient client) {
        this.client = client;
    }

    /** List all labels available in the business account. */
    public List<LabelRecord> list(String sessionId) {
        return client.requestList(
            HttpMethod.GET, "/api/sessions/" + encodeSegment(sessionId) + "/labels", null, null, LabelRecord.class);
    }

    /** Get a single label by id. */
    public LabelRecord get(String sessionId, String labelId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/labels/" + encodeSegment(labelId),
            null,
            null,
            LabelRecord.class);
    }

    /** Get the labels currently applied to a chat. */
    public List<LabelRecord> forChat(String sessionId, String chatId) {
        return client.requestList(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/labels/chat/" + encodeSegment(chatId),
            null,
            null,
            LabelRecord.class);
    }

    /** Add a label to a chat. Requires an OPERATOR-level key. */
    public SuccessResult addToChat(String sessionId, String chatId, AddLabelRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/labels/chat/" + encodeSegment(chatId),
            null,
            body,
            SuccessResult.class);
    }

    /** Remove a label from a chat. Requires an OPERATOR-level key. */
    public SuccessResult removeFromChat(String sessionId, String chatId, String labelId) {
        return client.request(
            HttpMethod.DELETE,
            "/api/sessions/" + encodeSegment(sessionId) + "/labels/chat/" + encodeSegment(chatId) + "/"
                + encodeSegment(labelId),
            null,
            null,
            SuccessResult.class);
    }
}
