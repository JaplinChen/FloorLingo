package io.github.japlinchen.floorlingo.resources;

import io.github.japlinchen.floorlingo.FloorLingoClient;
import io.github.japlinchen.floorlingo.http.HttpMethod;
import io.github.japlinchen.floorlingo.model.HealthReadyResponse;
import io.github.japlinchen.floorlingo.model.HealthResponse;

/** Health resource — connectivity and readiness probes. */
public final class HealthResource {
    private final FloorLingoClient client;

    public HealthResource(FloorLingoClient client) {
        this.client = client;
    }

    /** General health (also returns the running version). */
    public HealthResponse check() {
        return client.request(HttpMethod.GET, "/api/health", null, null, HealthResponse.class);
    }

    /** Kubernetes liveness probe. */
    public HealthResponse live() {
        return client.request(HttpMethod.GET, "/api/health/live", null, null, HealthResponse.class);
    }

    /** Kubernetes readiness probe — checks both DB connections. */
    public HealthReadyResponse ready() {
        return client.request(HttpMethod.GET, "/api/health/ready", null, null, HealthReadyResponse.class);
    }
}
