<?php
declare(strict_types=1);

// The Woo test bootstrap supplies WordPress/session fakes. Consent and HTTP
// contract handling run through the real plugin classes and the composed API.
use ModaInteract\WooCommerce\Api\ModaApiClient;
use ModaInteract\WooCommerce\Api\ModaApiConfiguration;
use ModaInteract\WooCommerce\Checkout\CheckoutConsentCapture;
use ModaInteract\WooCommerce\Checkout\CheckoutConsentCheckbox;
use ModaInteract\WooCommerce\Checkout\CheckoutConsentEligibility;
use ModaInteract\WooCommerce\Checkout\CheckoutConsentProof;
use ModaInteract\WooCommerce\Checkout\CheckoutConsentPublisher;
use ModaInteract\WooCommerce\Checkout\CheckoutConsentStatusReader;
use ModaInteract\WooCommerce\Connection\InstallationStore;
use ModaInteract\WooCommerce\Connection\SiteIdentity;

$root = getenv('MODA_WOO_SOURCE_ROOT');
require $root . '/tests/bootstrap.php';
require_once $root . '/tests/fixtures/Arch046CheckoutTestFakes.php';

$fixture = json_decode((string) getenv('MODA_CONSENT_FIXTURE'), true, 16, JSON_THROW_ON_ERROR);
$origin = $fixture['origin'];
if (!preg_match('#^http://127\.0\.0\.1:[0-9]+$#D', $origin)) {
    throw new RuntimeException('Expected a disposable loopback API');
}
$GLOBALS['arch046_nonce_action'] = 'update-order-review';
$GLOBALS['arch046_current_user_id'] = 42;
$GLOBALS['arch046_user_meta'] = [];
$GLOBALS['moda_interact_home_url'] = $fixture['installation']['canonicalSiteUrl'];
$GLOBALS['moda_interact_store_locale'] = 'en_GB';
$GLOBALS['moda_interact_options'] = [
    'blogname' => 'Test Merchant',
    InstallationStore::OPTION_NAME => $fixture['installation'],
];
$GLOBALS['arch046_woo'] = (object) [
    'session' => new Arch046Session(), 'cart' => new Arch046Cart(),
    'customer' => new Arch046Customer(), 'countries' => new Arch046Countries(),
];
$GLOBALS['arch035_wc'] = $GLOBALS['arch046_woo'];

$requests = [];
$transport = static function (string $url, array $args) use ($origin, &$requests): array {
    if (!str_starts_with($url, $origin . '/')) {
        throw new RuntimeException('Unexpected API origin');
    }
    $path = parse_url($url, PHP_URL_PATH);
    $requests[] = ['path' => $path, 'body' => json_decode($args['body'], true, 16, JSON_THROW_ON_ERROR)];
    $headers = [];
    foreach ($args['headers'] as $name => $value) {
        $headers[] = $name . ': ' . $value;
    }
    $body = file_get_contents($url, false, stream_context_create(['http' => [
        'method' => $args['method'], 'header' => implode("\r\n", $headers),
        'content' => $args['body'], 'ignore_errors' => true, 'follow_location' => 0,
        'timeout' => 5,
    ]]));
    if ($body === false || !preg_match('/^HTTP\/\S+ (\d{3}) /', $http_response_header[0] ?? '', $match)) {
        throw new RuntimeException('Disposable API transport failed');
    }
    $requests[array_key_last($requests)]['status'] = (int) $match[1];
    return ['response' => ['code' => (int) $match[1]], 'body' => $body,
        'headers' => ['content-type' => 'application/json']];
};

$client = new ModaApiClient(ModaApiConfiguration::fromServerConfiguration($origin, 'local-development'), $transport);
$store = new InstallationStore();
$publisher = new CheckoutConsentPublisher($client, $store,
    new SiteIdentity(ModaApiConfiguration::MODE_PUBLIC, static fn (string $host): array => ['93.184.216.34']));
$reader = new CheckoutConsentStatusReader(static fn (array $proof): string =>
    $client->wooConsentStatus($fixture['installation'], $proof));
$makeCapture = static fn (): CheckoutConsentCapture => new CheckoutConsentCapture(
    $publisher, new CheckoutConsentEligibility($store), new CheckoutConsentProof(), $reader);
$phone = $fixture['phone'];
$_POST['security'] = 'arch046-fixture-nonce';
$makeCapture()->classicReview('billing_phone=' . rawurlencode('+' . $phone) . '&billing_country=GB&'
    . CheckoutConsentCheckbox::CLASSIC_FIELD . '=1&moda_interact_whatsapp_recovery_checked_action=1');
$GLOBALS['arch046_woo']->session = new Arch046Session();
$confirmed = $makeCapture()->hasConfirmedPermission('+' . $phone, 'GB');
if (!$confirmed || array_column($requests, 'path') !== [
    '/v1/woocommerce/whatsapp-consent', '/v1/woocommerce/whatsapp-consent/status',
] || array_column($requests, 'status') !== [200, 200]
    || $requests[0]['body']['decision'] !== 'GRANT'
    || $requests[1]['body']['grantEventId'] !== $requests[0]['body']['eventId']
    || $requests[1]['body']['canonicalPhone'] !== $phone) {
    throw new RuntimeException('Returning checkout did not confirm the acknowledged grant through a single status read');
}
echo json_encode(['confirmed' => $confirmed, 'eventId' => $requests[0]['body']['eventId']], JSON_THROW_ON_ERROR);
