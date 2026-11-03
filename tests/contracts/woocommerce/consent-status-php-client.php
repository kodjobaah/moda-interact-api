<?php
/**
 * Execute the REAL WooCommerce ModaApiClient::wooConsentStatus() from a supplied
 * repository checkout against API-006's actual HTTP response bytes. No local copy
 * of the client parser or any production WooCommerce files is included here.
 *
 * Usage: MODA_WOO_SOURCE_ROOT=/path/to/moda-interact-woocommerce php ... < cases.json
 */

declare(strict_types=1);

define('ABSPATH', __DIR__);

function wp_json_encode(mixed $value): string|false { return json_encode($value); }
function wp_remote_retrieve_response_code(array $response): int {
    return (int) ($response['status'] ?? 0);
}
function wp_remote_retrieve_header(array $response, string $header): string {
    return (string) ($response['headers'][strtolower($header)] ?? '');
}
function wp_remote_retrieve_body(array $response): string {
    return (string) ($response['body'] ?? '');
}

$root = getenv('MODA_WOO_SOURCE_ROOT');
if (!is_string($root) || !is_file($root . '/includes/Api/ModaApiClient.php')) {
    fwrite(STDERR, "MODA_WOO_SOURCE_ROOT must point to the real WooCommerce implementation repository\n");
    exit(2);
}

require_once $root . '/includes/Security/Base64Url.php';
require_once $root . '/includes/Connection/InstallationStore.php';
require_once $root . '/includes/Api/ModaApiConfiguration.php';
require_once $root . '/includes/Api/ModaApiClient.php';

use ModaInteract\WooCommerce\Api\ModaApiClient;
use ModaInteract\WooCommerce\Api\ModaApiClientException;
use ModaInteract\WooCommerce\Api\ModaApiConfiguration;
use ModaInteract\WooCommerce\Security\Base64Url;

$payload = json_decode((string) stream_get_contents(STDIN), true, 16, JSON_THROW_ON_ERROR);
if (!is_array($payload) || !isset($payload['cases']) || !is_array($payload['cases'])) {
    throw new RuntimeException('Invalid local contract fixture');
}

$connection = array(
    'schemaVersion' => 1,
    'installationId' => 'contract-installation',
    'shopId' => 'contract-shop',
    'canonicalSiteUrl' => 'http://localhost:8888',
    'credential' => Base64Url::encode(str_repeat('a', 32)),
    'credentialVersion' => 1,
    'connectedAt' => '2026-01-01T00:00:00Z',
);
$proof = array('grantEventId' => 'contract-grant-01', 'canonicalPhone' => '447400123456');
$selected = null;
$transport = static function (string $url, array $args) use (&$selected, $proof): array {
    if (!str_ends_with($url, '/v1/woocommerce/whatsapp-consent/status') ||
        ($args['method'] ?? '') !== 'POST' || ($args['timeout'] ?? 0) !== 3 ||
        ($args['headers']['Cache-Control'] ?? '') !== 'no-store') {
        throw new RuntimeException('Woo client changed HTTP contract');
    }
    $sent = json_decode((string) ($args['body'] ?? ''), true);
    if ($sent !== array('schemaVersion' => 'woo.whatsapp-consent-status.v1',
        'canonicalPhone' => $proof['canonicalPhone'], 'grantEventId' => $proof['grantEventId'])) {
        throw new RuntimeException('Woo client changed request payload');
    }
    return $selected;
};
$config = ModaApiConfiguration::fromServerConfiguration('http://localhost:3100', 'local-development');
if (null === $config) throw new RuntimeException('Missing test configuration');
$client = new ModaApiClient($config, $transport);
foreach ($payload['cases'] as $case) {
    $selected = array('status' => $case['httpStatus'], 'body' => $case['body'],
        'headers' => array('content-type' => 'application/json'));
    try {
        $actual = $client->wooConsentStatus($connection, $proof);
        if (($case['expectedState'] ?? null) !== $actual) {
            throw new RuntimeException('Woo PHP client accepted an unexpected response');
        }
    } catch (ModaApiClientException $error) {
        if (($case['expectedError'] ?? null) !== $error->getMessage()) {
            throw $error;
        }
    }
}
fwrite(STDOUT, 'Woo PHP client accepted API-006 response contract (' . count($payload['cases']) . " cases)\n");
