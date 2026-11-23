<?php
declare(strict_types=1);
// Zero-PII aggregate counter for aispend.live (StableHost / LiteSpeed).
// Stores ONLY aggregate integers in counter-data.json: no IPs, cookies, user-agents, or referrers.
@ini_set('display_errors', '0');
error_reporting(0);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('X-Content-Type-Options: nosniff');

$dataFile = __DIR__ . '/counter-data.json';
$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));

function normalizeCounter($raw): array {
  $views = (is_array($raw) && isset($raw['views']) && is_numeric($raw['views'])) ? max(0, (int)$raw['views']) : 0;
  $daily = [];
  if (is_array($raw) && isset($raw['dailyViews']) && is_array($raw['dailyViews'])) {
    foreach ($raw['dailyViews'] as $day => $count) {
      if (is_string($day) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $day) && is_numeric($count)) {
        $daily[$day] = max(0, (int)$count);
      }
    }
    ksort($daily);
    if (count($daily) > 90) {
      $daily = array_slice($daily, -90, 90, true);
    }
  }
  $downloads = [];
  if (is_array($raw) && isset($raw['downloads']) && is_array($raw['downloads'])) {
    foreach ($raw['downloads'] as $asset => $count) {
      if (is_string($asset) && preg_match('/^[a-zA-Z0-9._-]{1,80}$/', $asset) && is_numeric($count)) {
        $downloads[$asset] = max(0, (int)$count);
      }
    }
  }
  $updatedAt = (is_array($raw) && isset($raw['updatedAt']) && is_string($raw['updatedAt'])) ? $raw['updatedAt'] : null;
  return [
    'views' => $views,
    'dailyViews' => (object)$daily,
    'downloads' => (object)$downloads,
    'updatedAt' => $updatedAt,
  ];
}

function respond(int $status, array $payload): void {
  http_response_code($status);
  $encoded = json_encode($payload, JSON_UNESCAPED_SLASHES);
  echo ($encoded === false) ? '{"error":"encode_failed"}' : $encoded;
  exit;
}

if ($method === 'GET' || $method === 'HEAD') {
  $data = normalizeCounter(null);
  if (is_file($dataFile)) {
    $fp = @fopen($dataFile, 'rb');
    if ($fp !== false) {
      if (@flock($fp, LOCK_SH)) {
        $raw = stream_get_contents($fp);
        @flock($fp, LOCK_UN);
        $decoded = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
        $data = normalizeCounter($decoded);
      }
      @fclose($fp);
    }
  }
  respond(200, $data);
}

if ($method !== 'POST') {
  respond(405, ['error' => 'method_not_allowed']);
}

$event = (string)($_GET['event'] ?? $_POST['event'] ?? '');
$asset = (string)($_GET['asset'] ?? $_POST['asset'] ?? '');

if ($event !== 'view' && $event !== 'download') {
  respond(400, ['error' => 'invalid_event']);
}
if ($event === 'download' && !preg_match('/^[a-zA-Z0-9._-]{1,80}$/', $asset)) {
  respond(400, ['error' => 'invalid_asset']);
}

$fp = @fopen($dataFile, 'c+b');
if ($fp === false || !@flock($fp, LOCK_EX)) {
  if ($fp !== false) {
    @fclose($fp);
  }
  respond(503, ['error' => 'storage_unavailable']);
}

$raw = stream_get_contents($fp);
$decoded = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
$state = normalizeCounter($decoded);
$daily = (array)$state['dailyViews'];
$downloads = (array)$state['downloads'];

if ($event === 'view') {
  $today = gmdate('Y-m-d');
  $state['views'] += 1;
  $daily[$today] = ($daily[$today] ?? 0) + 1;
  ksort($daily);
  if (count($daily) > 90) {
    $daily = array_slice($daily, -90, 90, true);
  }
} else {
  if (isset($downloads[$asset]) || count($downloads) < 64) {
    $downloads[$asset] = ($downloads[$asset] ?? 0) + 1;
  }
}

$state['dailyViews'] = (object)$daily;
$state['downloads'] = (object)$downloads;
$state['updatedAt'] = gmdate('Y-m-d\TH:i:s\Z');

$encoded = json_encode($state, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
if ($encoded !== false) {
  @rewind($fp);
  @ftruncate($fp, 0);
  @fwrite($fp, $encoded . "\n");
  @fflush($fp);
}
@flock($fp, LOCK_UN);
@fclose($fp);

respond(200, $state);
