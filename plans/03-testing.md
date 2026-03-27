# Phase 3 — Testing (`test/index.test.ts`)

## Steps

3.1. Create `test/index.test.ts` with the test cases below.

## Test cases

### Startup validation

- **Missing `MCP_SERVER_URL`** — process exits with code 1 and stderr message.
- **Non-HTTPS `MCP_SERVER_URL` (`http://`)** — `http://example.com` is rejected with stderr message.
- **Non-HTTPS `MCP_SERVER_URL` (`file://`)** — `file:///etc/passwd` is rejected (SSRF vector).
- **Non-HTTPS `MCP_SERVER_URL` (`ftp://`)** — `ftp://example.com` is rejected.
- **`NODE_TLS_REJECT_UNAUTHORIZED=0`** — process exits with code 1 and stderr message.

### Input validation

- **Valid JSON-RPC** — message is signed and forwarded (mock `fetch`).
- **Non-JSON input** — line is ignored, warning written to stderr.
- **JSON but not JSON-RPC** — `{"foo": "bar"}` is ignored, warning written to stderr.
- **Empty lines** — silently skipped.

### SigV4 signing

- **Signing headers present** — outgoing request contains `Authorization`, `X-Amz-Date`, and `X-Amz-Security-Token` (if using session credentials) headers.
- **Correct host header** — matches `MCP_SERVER_URL` hostname.

### Response handling — JSON

- **200 JSON response** — body is written as a single line to stdout.
- **200 non-JSON response** — body is dropped, warning written to stderr.

### Response handling — SSE

- **200 SSE stream** — each `data:` line is written as a separate line to stdout.
- **SSE with non-JSON data** — non-JSON `data:` lines are dropped, warning written to stderr.
- **SSE buffer overflow** — stream exceeding 1 MB buffer is aborted, JSON-RPC error emitted to stdout.

### Error handling

- **HTTP 403** — sanitized JSON-RPC error on stdout (no raw body), full error on stderr.
- **HTTP 500** — same as 403.
- **Network error** — JSON-RPC error on stdout, full error on stderr.
- **Error includes request `id`** — JSON-RPC error response echoes the original request's `id` field.
- **Error for notification (no `id`)** — JSON-RPC error has `id: null`.

### Sequential processing

- **Multiple rapid lines** — responses arrive in input order (not interleaved).

### Graceful shutdown

- **stdin close** — in-flight requests are drained before exit.
- **SIGTERM** — readline interface is closed, in-flight requests drained.

## Testing approach

- Mock `fetch` globally to control HTTP responses.
- Mock `SignatureV4.sign()` to verify it's called with the correct `HttpRequest` and to return predictable headers.
- Capture `process.stdout.write` and `process.stderr.write` calls to assert output.
- Use `jest.spyOn(process, 'exit')` to test exit behavior without killing the test runner.
- For sequential processing tests: mock `fetch` with varying delays and verify output order matches input order.
