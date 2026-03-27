# Phase 2 — Implementation (`src/index.ts`)

## Steps

2.1. Create `src/index.ts` with the proxy logic below.

Note: The shebang is prepended by the `build` script in package.json (see [01-scaffolding.md](01-scaffolding.md)). Do **not** put a shebang in the TypeScript source — `tsc` will not preserve it.

## Proxy responsibilities

1. Validate environment and enforce security invariants
2. Sign stdin JSON-RPC requests with SigV4
3. Forward signed requests sequentially to the target MCP endpoint
4. Relay responses (JSON or SSE) back to stdout

## 1. Startup validation and security checks

```typescript
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import readline from 'readline';

// --- Startup validation ---

if (!process.env.MCP_SERVER_URL) {
  process.stderr.write('mcp-sigv4-proxy: MCP_SERVER_URL is required\n');
  process.exit(1);
}

// SECURITY: Reject unsafe TLS override — this proxy signs requests with real
// AWS credentials; allowing unverified TLS would enable credential interception.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  process.stderr.write(
    'mcp-sigv4-proxy: NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed — ' +
    'this proxy sends signed AWS credentials and requires verified TLS\n'
  );
  process.exit(1);
}

// SECURITY: Enforce HTTPS-only to prevent SSRF and credential leakage.
// A misconfigured URL pointing to http://169.254.169.254 (IMDS), file:// paths,
// or internal services would otherwise have requests signed with real AWS credentials.
const url = new URL(process.env.MCP_SERVER_URL);
if (url.protocol !== 'https:') {
  process.stderr.write(
    `mcp-sigv4-proxy: MCP_SERVER_URL must use https:// (got ${url.protocol})\n`
  );
  process.exit(1);
}
```

## 2. Credential and signing setup

```typescript
const region = process.env.AWS_REGION ?? 'us-east-1';
const service = process.env.AWS_SERVICE ?? 'bedrock-agentcore';

const signer = new SignatureV4({
  credentials: fromNodeProviderChain(),   // respects AWS_PROFILE automatically
  region,
  service,
  sha256: Sha256,
});
```

`fromNodeProviderChain()` reads `AWS_PROFILE` from the environment — no explicit profile argument needed.

## 3. stdin -> sequential signed POST -> target (with input validation)

MCP stdio is inherently sequential — the client expects responses in request order. To prevent out-of-order delivery and unbounded concurrency, lines are processed one at a time using a queue.

```typescript
const rl = readline.createInterface({ input: process.stdin, terminal: false });

// Sequential processing queue — prevents concurrent fetch calls that could
// deliver responses out of order (violating MCP stdio assumptions) and avoids
// unbounded parallelism from rapid stdin input.
let pending: Promise<void> = Promise.resolve();

rl.on('line', (line) => {
  pending = pending.then(() => processLine(line)).catch(() => {});
});

async function processLine(line: string): Promise<void> {
  const body = line.trim();
  if (!body) return;

  // SECURITY: Validate input is well-formed JSON-RPC before signing.
  // Without this, arbitrary payloads get signed with real AWS credentials.
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    process.stderr.write('mcp-sigv4-proxy: ignoring non-JSON input line\n');
    return;
  }

  if (
    typeof parsed !== 'object' || parsed === null ||
    (parsed as Record<string, unknown>).jsonrpc !== '2.0'
  ) {
    process.stderr.write('mcp-sigv4-proxy: ignoring non-JSON-RPC message\n');
    return;
  }

  // Extract request id for error correlation (notifications have no id)
  const requestId = (parsed as Record<string, unknown>).id ?? null;

  const request = new HttpRequest({
    method: 'POST',
    hostname: url.hostname,
    path: url.pathname + url.search,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      host: url.hostname,
    },
    body,
  });

  try {
    const signed = await signer.sign(request);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: signed.headers as Record<string, string>,
      body,
    });

    await handleResponse(response, requestId);
  } catch (err) {
    // Log full error to stderr for debugging; send sanitized error to client
    process.stderr.write(`mcp-sigv4-proxy: request failed: ${err}\n`);
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32000, message: 'Proxy request failed' },
    }) + '\n');
  }
}
```

## 4. Response handling (JSON + SSE) with output validation

```typescript
const MAX_SSE_BUFFER_BYTES = 1_048_576; // 1 MB

async function handleResponse(response: Response, requestId: unknown) {
  if (!response.ok) {
    // SECURITY: Do not forward raw AWS error bodies — they may contain
    // request IDs, signed headers, or internal endpoint details.
    // Log full body to stderr for debugging; send sanitized message to client.
    const text = await response.text();
    process.stderr.write(
      `mcp-sigv4-proxy: HTTP ${response.status}: ${text}\n`
    );
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32000, message: `HTTP ${response.status}` },
    }) + '\n');
    return;
  }

  const ct = response.headers.get('content-type') ?? '';

  if (ct.includes('text/event-stream')) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SECURITY: Prevent unbounded memory growth from a malicious server
      // sending a continuous stream without newlines.
      if (Buffer.byteLength(buffer) > MAX_SSE_BUFFER_BYTES) {
        process.stderr.write(
          'mcp-sigv4-proxy: SSE buffer exceeded 1 MB limit, aborting stream\n'
        );
        reader.cancel();
        // Emit error to client so it knows the stream was truncated
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          error: { code: -32000, message: 'SSE stream exceeded buffer limit' },
        }) + '\n');
        break;
      }

      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          // SECURITY: Validate SSE data payloads are valid JSON before
          // forwarding to the MCP client's stdin.
          try {
            JSON.parse(data); // validate only — write original string
            process.stdout.write(data + '\n');
          } catch {
            process.stderr.write(
              `mcp-sigv4-proxy: dropping non-JSON SSE data: ${data.slice(0, 100)}\n`
            );
          }
        }
      }
    }
  } else {
    // Plain JSON response — validate before forwarding (consistent with SSE path)
    const text = await response.text();
    const trimmed = text.trim();
    try {
      JSON.parse(trimmed); // validate only — write original string
      process.stdout.write(trimmed + '\n');
    } catch {
      process.stderr.write(
        `mcp-sigv4-proxy: dropping non-JSON response body: ${trimmed.slice(0, 100)}\n`
      );
    }
  }
}
```

## 5. Graceful shutdown

```typescript
// Track in-flight work so shutdown can drain before exiting.
rl.on('close', async () => {
  process.stderr.write('mcp-sigv4-proxy: stdin closed, draining in-flight requests\n');
  await pending;
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.stderr.write('mcp-sigv4-proxy: received SIGTERM, shutting down\n');
  rl.close();
});

process.on('SIGINT', () => {
  process.stderr.write('mcp-sigv4-proxy: received SIGINT, shutting down\n');
  rl.close();
});
```

## Security summary

| Threat | Mitigation |
|---|---|
| SSRF via `MCP_SERVER_URL` | Enforce `https://` scheme only (blocks `http://`, `file://`, `ftp://`, etc.) |
| Credential interception via TLS bypass | Reject `NODE_TLS_REJECT_UNAUTHORIZED=0` at startup |
| Signing arbitrary payloads | Validate input is JSON-RPC 2.0 before signing |
| Credential leakage in error responses | Sanitize HTTP error bodies; log full details to stderr |
| Unbounded memory from malicious SSE | Cap SSE buffer at 1 MB; emit JSON-RPC error to client on overflow |
| Injected non-JSON SSE data | Validate each SSE data payload is valid JSON |
| Non-JSON response body | Validate JSON responses same as SSE path |
| Out-of-order responses | Sequential line processing via promise queue |
| Request/error correlation | Echo request `id` in JSON-RPC error responses |
| Orphaned process on client disconnect | Handle `SIGTERM`, `SIGINT`, and stdin `close`; drain in-flight requests before exit |
