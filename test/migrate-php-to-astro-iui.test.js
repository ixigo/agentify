import assert from "node:assert/strict";
import test from "node:test";

import {
  auditHtml,
} from "../skills/migrate-php-to-astro-iui/scripts/audit-rendered-route.mjs";
import {
  inventoryPhpSource,
} from "../skills/migrate-php-to-astro-iui/scripts/inventory-php-page.mjs";

test("inventoryPhpSource extracts legacy PHP, API, SEO, and AMP contracts", () => {
  const source = `<?php
include "config.php";
$source = $_REQUEST["source"];
$seoUrl = "https://example.test/api/v2/trains/search";
$seoData["Distance"];
$handle = curl_init();
header("Location: /trains/example", true, 301);
function routeName($value) { return $value; }
?>
<!doctype html>
<html lang="<?php echo $language; ?>" amp>
  <head>
    <meta name="description" content="<?php echo $description; ?>">
    <link rel="canonical" href="<?php echo $canonical; ?>">
    <script type="application/ld+json">
      { "@context": "https://schema.org", "@type": "FAQPage" }
    </script>
    <script type="module" data-label="include">
      const ignored = "not-a-php-include";
    </script>
  </head>
  <body>
    <h1>Trains from <?php echo $source; ?></h1>
    <amp-img src="/train.webp" width="100" height="100"></amp-img>
  </body>
</html>`;

  const inventory = inventoryPhpSource(source, {
    filePath: "/tmp/train-a2b.php",
  });

  assert.equal(inventory.source.path, "/tmp/train-a2b.php");
  assert.deepEqual(inventory.php.includes, [
    { kind: "include", path: "config.php", line: 2 },
  ]);
  assert.deepEqual(inventory.php.request_inputs, ["request.source"]);
  assert.ok(inventory.php.functions.some((entry) => entry.name === "routeName"));
  assert.ok(inventory.php.data_keys.includes("seoData.Distance"));
  assert.equal(inventory.php.curl_calls, 1);
  assert.equal(inventory.php.redirect_headers.length, 1);
  assert.equal(inventory.document.amp_enabled, true);
  assert.equal(inventory.document.h1_count, 1);
  assert.ok(inventory.document.meta_names.includes("description"));
  assert.ok(inventory.document.link_relations.includes("canonical"));
  assert.ok(inventory.document.schema_types.includes("FAQPage"));
  assert.ok(
    inventory.network.absolute_urls.includes(
      "https://example.test/api/v2/trains/search"
    )
  );
  assert.deepEqual(inventory.network.api_paths, [
    "https://example.test/api/v2/trains/search",
  ]);
});

test("auditHtml passes a semantic, canonical, structured route response", () => {
  const canonical =
    "https://www.confirmtkt.com/trains/bengaluru-to-mumbai-train-tickets";
  const html = `<!doctype html>
<html lang="en">
  <head>
    <title>Bengaluru to Mumbai Trains | ConfirmTkt</title>
    <meta name="description" content="Book Bengaluru to Mumbai train tickets and compare routes.">
    <meta name="robots" content="index, follow">
    <link rel="canonical" href="${canonical}">
    <script type="application/ld+json">
      { "@context": "https://schema.org", "@type": "WebPage" }
    </script>
  </head>
  <body>
    <header><nav><a href="/">Home</a></nav></header>
    <main>
      <h1>Bengaluru to Mumbai trains</h1>
      <h2>Available trains</h2>
      <img src="/train.webp" alt="Train" width="320" height="180">
      <p>Compare train timings, classes, fares, availability, departure stations,
      arrival stations, duration, running days, booking choices, route details,
      cancellation options, support information, and useful railway services for
      this journey. Choose a suitable train and continue to the secure ConfirmTkt
      booking experience. Review the first train, last train, fastest option,
      cheapest fare, daily services, weekly services, nearby alternatives, return
      route, frequently asked questions, and related train routes before booking.
      This server-rendered route keeps important content and links available
      without client JavaScript and reserves browser code for real interaction.</p>
    </main>
    <footer>ConfirmTkt</footer>
  </body>
</html>`;

  const report = auditHtml(html, {
    expectCanonical: canonical,
    status: 200,
    finalUrl: canonical,
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.metadata.canonical, canonical);
  assert.equal(report.content.h1_count, 1);
  assert.deepEqual(report.structured_data.types, ["WebPage"]);
});

test("auditHtml reports canonical, heading, JSON-LD, and image failures", () => {
  const report = auditHtml(
    `<!doctype html>
    <html lang="en">
      <head>
        <title>Broken route</title>
        <meta name="description" content="Broken route fixture">
        <link rel="canonical" href="https://example.test/wrong">
        <script type="application/ld+json">{ broken }</script>
      </head>
      <body>
        <main>
          <h1>First</h1>
          <h1>Second</h1>
          <img src="/missing-alt.webp">
        </main>
      </body>
    </html>`,
    {
      expectCanonical: "https://example.test/expected",
      status: 200,
    }
  );

  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.startsWith("Canonical mismatch")));
  assert.ok(report.errors.includes("Expected exactly one h1, found 2."));
  assert.ok(report.errors.some((error) => error.startsWith("Invalid JSON-LD")));
  assert.ok(report.errors.includes("Image 1 is missing an alt attribute."));
});
