#!/usr/bin/env node

const [, , command, ...args] = process.argv;

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

const baseUrl = option('url', process.env.TOMAHAWK1_CONTROL_URL || 'http://127.0.0.1:3001');

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Tomahawk control API returned ${response.status}.`);
  return payload;
}

try {
  const controlUrl = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(controlUrl.hostname)) {
    throw new Error('The Tomahawk control API must be loopback-local.');
  }
  if (command === 'stop') {
    const result = await post('/api/security/live-validation/stop', {
      operator: option('operator', process.env.USERNAME || process.env.USER || 'cli-operator'),
      reason: option('reason', 'Operator invoked tomahawk stop.'),
      hardNetworkStop: hasFlag('hard-network-stop'),
    });
    console.log(`LIVE_VALIDATION stopped: ${result.stopState.reason}`);
  } else if (command === 'restart') {
    const result = await post('/api/security/live-validation/restart', {
      operator: option('operator', process.env.USERNAME || process.env.USER || ''),
      acknowledgement: option('acknowledgement', ''),
    });
    console.log(`LIVE_VALIDATION explicitly restarted by ${result.operator}.`);
  } else {
    console.error(
      'Usage:\n' +
        '  tomahawk stop [--reason "..."] [--operator NAME] [--hard-network-stop] [--url URL]\n' +
        '  tomahawk restart --operator NAME --acknowledgement "RESTART LIVE VALIDATION" [--url URL]',
    );
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
