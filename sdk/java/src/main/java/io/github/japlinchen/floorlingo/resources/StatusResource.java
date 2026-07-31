package io.github.japlinchen.floorlingo.resources;

import static io.github.japlinchen.floorlingo.http.Http.encodeSegment;

import io.github.japlinchen.floorlingo.FloorLingoClient;
import io.github.japlinchen.floorlingo.http.HttpMethod;
import io.github.japlinchen.floorlingo.model.SendImageStatusRequest;
import io.github.japlinchen.floorlingo.model.SendTextStatusRequest;
import io.github.japlinchen.floorlingo.model.SendVideoStatusRequest;
import io.github.japlinchen.floorlingo.model.StatusListResult;
import io.github.japlinchen.floorlingo.model.StatusResult;

/**
 * Status (Stories) resource — WhatsApp status updates.
 *
 * <p>NOTE: this is WhatsApp "Status/Stories", distinct from session lifecycle status.
 */
public final class StatusResource {
    private final FloorLingoClient client;

    public StatusResource(FloorLingoClient client) {
        this.client = client;
    }

    /** Get all status updates. */
    public StatusListResult list(String sessionId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/status",
            null,
            null,
            StatusListResult.class);
    }

    /** Get status updates from a specific contact. */
    public StatusListResult fromContact(String sessionId, String contactId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/status/" + encodeSegment(contactId),
            null,
            null,
            StatusListResult.class);
    }

    /** Post a text status update. */
    public StatusResult sendText(String sessionId, SendTextStatusRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/status/send-text",
            null,
            body,
            StatusResult.class);
    }

    /** Post an image status update. */
    public StatusResult sendImage(String sessionId, SendImageStatusRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/status/send-image",
            null,
            body,
            StatusResult.class);
    }

    /** Post a video status update. */
    public StatusResult sendVideo(String sessionId, SendVideoStatusRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/status/send-video",
            null,
            body,
            StatusResult.class);
    }

    /** Delete a status update by id. */
    public void delete(String sessionId, String statusId) {
        client.requestVoid(
            HttpMethod.DELETE,
            "/api/sessions/" + encodeSegment(sessionId) + "/status/" + encodeSegment(statusId),
            null,
            null);
    }
}
