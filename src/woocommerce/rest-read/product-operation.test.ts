import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareWooProductRequest, projectWooProducts, WooProductInputError, WooProductResponseError,
} from "./product-operation.js";

test("product allowlist fixes method, path, context and result bounds", () => {
  const list = prepareWooProductRequest({ operation: "products.list", page: 2, perPage: 5, search: "Hats & Shoes" });
  assert.equal(list.operation, "products.list");
  assert.equal(list.maxItems, 5);
  assert.equal(list.maxBytes <= 131072, true);
  assert.equal(list.path.startsWith("/wp-json/wc/v3/products?"), true);
  const parsed = new URL(list.path, "https://fixture.invalid");
  assert.equal(parsed.searchParams.get("context"), "view");
  assert.equal(parsed.searchParams.get("search"), "Hats & Shoes");
  assert.equal(parsed.searchParams.get("per_page"), "5");
  assert.equal(parsed.searchParams.has("consumer_key"), false);
  const detail = prepareWooProductRequest({ operation: "products.retrieve", productId: 42 });
  assert.equal(new URL(detail.path, "https://fixture.invalid").pathname, "/wp-json/wc/v3/products/42");
});

test("product allowlist rejects unsafe inputs and unsupported operations", () => {
  for (const request of [
    { operation: "products.create" },
    { operation: "orders.list" },
    { operation: "products.list", url: "http://169.254.169.254" },
    { operation: "products.list", method: "POST" },
    { operation: "products.list", perPage: 500 },
    { operation: "products.list", page: -1 },
    { operation: "products.list", search: "bad\r\nAuthorization: Basic" },
    { operation: "products.list", search: "x".repeat(101) },
    { operation: "products.retrieve", productId: "1/../orders" },
    { operation: "products.retrieve", productId: 0 },
    { operation: "products.retrieve", productId: 1, context: "edit" },
    { operation: "products.retrieve", productId: 1, headers: { authorization: "x" } },
  ]) assert.throws(() => prepareWooProductRequest(request), WooProductInputError);
});

test("provider response projects only explicitly permitted product fields", () => {
  const list = prepareWooProductRequest({ operation: "products.list", perPage: 2 });
  const body = [{
    id: 27, name: "Cool Shirt", sku: "CS-42", price: "12.30", stock_status: "instock", stock_quantity: 3,
    billing_email: "should-not-escape@example.com", consumer_secret: "should-not-escape",
    meta_data: [{ key: "private", value: "should-not-escape" }],
  }];
  const projected = projectWooProducts(body, list);
  assert.deepEqual(projected, [{
    id: 27, name: "Cool Shirt", sku: "CS-42", price: "12.30", stockStatus: "instock", stockQuantity: 3,
  }]);
  assert.equal(JSON.stringify(projected).includes("should-not-escape"), false);
  assert.throws(() => projectWooProducts([...body, ...body, ...body], list), WooProductResponseError);
  assert.throws(() => projectWooProducts({ order_id: 22 }, list), WooProductResponseError);
  const detail = prepareWooProductRequest({ operation: "products.retrieve", productId: 27 });
  assert.deepEqual(projectWooProducts(body[0], detail), projected[0]);
  assert.throws(() => projectWooProducts([{ ...body[0], id: "not-numeric" }], list), WooProductResponseError);
});
