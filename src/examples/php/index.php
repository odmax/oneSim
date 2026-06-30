<?php
// OneSim Africa API — PHP Examples
// Base URL: https://staging.onetelecom.cloud/api/v1 (staging)
//           https://m2m.onetelecom.cloud/api/v1 (production)
// Auth: x-api-key header with your API key

define('API_KEY', 'YOUR_API_KEY');
define('BASE_URL', 'https://staging.onetelecom.cloud/api/v1');

function api($path, $method = 'GET', $body = null, $headers = []) {
    $ch = curl_init(BASE_URL . $path);
    
    $defaultHeaders = [
        'Content-Type: application/json',
        'x-api-key: ' . API_KEY,
    ];
    
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => array_merge($defaultHeaders, $headers),
        CURLOPT_TIMEOUT => 30,
    ]);
    
    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        if ($body) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }
    
    if ($method === 'PATCH') {
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'PATCH');
        if ($body) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    
    return json_decode($response, true);
}

// 1. List packages
function listPackages() {
    return api('/packages');
}

// 2. Create customer
function createCustomer($name, $email, $phone = null, $country = null) {
    return api('/customers', 'POST', [
        'name' => $name,
        'email' => $email,
        'phone' => $phone,
        'country' => $country,
    ]);
}

// 3. Order eSIM (with idempotency)
function orderESIM($packageId, $quantity, $customerName, $customerEmail, $idempotencyKey = null) {
    $headers = [];
    if ($idempotencyKey) $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
    
    return api('/esims/order', 'POST', [
        'packageId' => $packageId,
        'quantity' => $quantity,
        'customerName' => $customerName,
        'customerEmail' => $customerEmail,
    ], $headers);
}

// 4. Get eSIM usage
function getEsimUsage($esimId) {
    return api("/esims/{$esimId}/usage");
}

// 5. Top-up eSIM
function topUpEsim($esimId, $packageId, $quantity = 1) {
    return api("/esims/{$esimId}/top-up", 'POST', [
        'packageId' => $packageId,
        'quantity' => $quantity,
    ]);
}

// 6. Verify webhook signature
function verifyWebhookSignature($payload, $signature, $timestamp, $secret) {
    $expected = hash_hmac('sha256', "{$timestamp}." . json_encode($payload), $secret);
    return hash_equals($expected, $signature);
}

// Example:
$packages = listPackages();
$order = orderESIM($packages[0]['id'], 1, 'John Doe', 'john@example.com', 'unique-key-456');
echo "Order ID: " . $order['order']['id'] . "\n";
echo "ICCID: " . $order['esims'][0]['iccid'] . "\n";
