import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { MODA_SUPPORTED_LANGUAGE_TAGS } from "@modainteract/moda-interact-shared/internationalization";
import { renderWooReadReturnPage } from "../../../../src/woocommerce/rest-read/return-page.js";

test("every supported merchant language has distinct approval and cancellation copy", () => {
  assert.equal(MODA_SUPPORTED_LANGUAGE_TAGS.length, 20);
  for (const locale of MODA_SUPPORTED_LANGUAGE_TAGS) {
    const approved = renderWooReadReturnPage(locale, false);
    const cancelled = renderWooReadReturnPage(locale, true);
    assert.match(approved.html, new RegExp(`<html lang="${locale}">`));
    assert.match(approved.html, /Moda Interact/);
    assert.match(approved.html, /WooCommerce/);
    assert.match(cancelled.html, /WooCommerce/);
    assert.notEqual(cancelled.html, approved.html);
    if (locale !== "en") {
      assert.equal(approved.html.includes("Return to your WooCommerce admin."), false);
      assert.equal(cancelled.html.includes("WooCommerce authorization was not completed."), false);
    }
  }
});

test("the only inline style is covered by the exact CSP hash; no scripts or external links", () => {
  const { html, contentSecurityPolicy } = renderWooReadReturnPage("fr", false);
  const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert.ok(css);
  const digest = createHash("sha256").update(css).digest("base64");
  assert.ok(contentSecurityPolicy.includes(`style-src 'sha256-${digest}'`));
  assert.ok(contentSecurityPolicy.includes("default-src 'none'"));
  assert.doesNotMatch(html, /<script|<iframe|<form|https?:\/\//i);
});
