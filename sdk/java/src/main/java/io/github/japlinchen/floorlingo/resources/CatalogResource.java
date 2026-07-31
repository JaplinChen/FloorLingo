package io.github.japlinchen.floorlingo.resources;

import static io.github.japlinchen.floorlingo.http.Http.encodeSegment;

import io.github.japlinchen.floorlingo.FloorLingoClient;
import io.github.japlinchen.floorlingo.http.HttpMethod;
import io.github.japlinchen.floorlingo.model.CatalogInfo;
import io.github.japlinchen.floorlingo.model.CatalogProduct;
import io.github.japlinchen.floorlingo.model.CatalogProductsQuery;
import io.github.japlinchen.floorlingo.model.MessageResponse;
import io.github.japlinchen.floorlingo.model.PaginatedProducts;
import io.github.japlinchen.floorlingo.model.SendCatalogRequest;
import io.github.japlinchen.floorlingo.model.SendProductRequest;

/**
 * Catalog resource — WhatsApp Business catalog, products, and product/catalog sends.
 *
 * <p>The catalog controller is mounted under the session root, so catalog reads are
 * {@code /catalog...} while product/catalog SENDS share the messages namespace
 * ({@code /messages/send-product}, {@code /messages/send-catalog}). Write operations
 * require an OPERATOR-level key.
 */
public final class CatalogResource {
    private final FloorLingoClient client;

    public CatalogResource(FloorLingoClient client) {
        this.client = client;
    }

    /** Get the business catalog info. */
    public CatalogInfo info(String sessionId) {
        return client.request(
            HttpMethod.GET, "/api/sessions/" + encodeSegment(sessionId) + "/catalog", null, null, CatalogInfo.class);
    }

    /** List catalog products. Returns a {@code { products, pagination }} page. */
    public PaginatedProducts products(String sessionId, CatalogProductsQuery query) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/catalog/products",
            query,
            null,
            PaginatedProducts.class);
    }

    /** Get a single product by id. */
    public CatalogProduct product(String sessionId, String productId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/catalog/products/" + encodeSegment(productId),
            null,
            null,
            CatalogProduct.class);
    }

    /** Send a product message. Requires an OPERATOR-level key. Shares the messages path. */
    public MessageResponse sendProduct(String sessionId, SendProductRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/send-product",
            null,
            body,
            MessageResponse.class);
    }

    /** Send a catalog link message. Requires an OPERATOR-level key. Shares the messages path. */
    public MessageResponse sendCatalog(String sessionId, SendCatalogRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/send-catalog",
            null,
            body,
            MessageResponse.class);
    }
}
