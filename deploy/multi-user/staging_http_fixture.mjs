// Deterministic protocol client, confined to a disposable network namespace.
// No browser, external origin, redirects, model calls or credential diagnostics.
import http from 'node:http';
import https from 'node:https';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const url = new URL(input.url);
  const secure = url.protocol === 'https:';
  const hosts = input.hosts ?? ['auth-staging.example.invalid', 'todo-staging.example.invalid',
    'mcp-staging.example.invalid'];
  assert(Array.isArray(hosts) && hosts.length === 3 && hosts.every(h =>
    typeof h === 'string' && /^[a-z0-9.-]+$/.test(h) && h.split('.')[0].split('-').includes('staging')));
  assert(!url.username && !url.password && !url.hash);
  if (secure) {
    assert(hosts.includes(url.hostname) && !url.port);
  } else {
    assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && ['19543', '19544'].includes(url.port));
  }
  const result = await new Promise((resolve, reject) => {
    const request = (secure ? https : http).request(url, {
      method: input.method ?? 'GET', headers: input.headers ?? {},
      ...(secure ? {ca: readFileSync('/fixture/ca.pem'),
        lookup: (_name, options, done) => options.all
          ? done(null, [{address: '127.0.0.1', family: 4}]) : done(null, '127.0.0.1', 4)} : {}),
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 262144) request.destroy(new Error('bounded'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('base64')}));
    });
    request.setTimeout(5000, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end(input.body ?? undefined);
  });
  process.stdout.write(JSON.stringify(result));
} catch {
  process.exitCode = 1;
}
