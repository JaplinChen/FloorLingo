package io.github.japlinchen.floorlingo.resources;

import io.github.japlinchen.floorlingo.FloorLingoClient;
import io.github.japlinchen.floorlingo.http.HttpMethod;
import io.github.japlinchen.floorlingo.model.SearchQuery;
import io.github.japlinchen.floorlingo.model.SearchResults;

/**
 * Search resource — full-text message search across sessions via {@code GET /search}.
 *
 * <p>Requires an OPERATOR-level API key. {@code q} is the only required parameter.
 */
public final class SearchResource {
    private final FloorLingoClient client;

    public SearchResource(FloorLingoClient client) {
        this.client = client;
    }

    /**
     * Search persisted messages via the active search provider.
     *
     * @param params query parameters; {@code q} must be non-null and non-blank.
     * @throws IllegalArgumentException if {@code params.q} is null or blank.
     */
    public SearchResults search(SearchQuery params) {
        if (params == null) {
            throw new IllegalArgumentException("Search params must not be null.");
        }
        if (params.q() == null || params.q().isBlank()) {
            throw new IllegalArgumentException("Search parameter \"q\" is required and must be non-empty.");
        }
        return client.request(HttpMethod.GET, "/api/search", params, null, SearchResults.class);
    }
}
