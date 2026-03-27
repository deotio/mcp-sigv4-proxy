# Implementation Checklist

## Phase 1 — Scaffolding ([01-scaffolding.md](01-scaffolding.md))

- [ ] 1.1 Create `package.json` with ESM config, bin entry, explicit `@aws-crypto/sha256-js` dep, shebang-prepending build script
- [ ] 1.2 Create `tsconfig.json` (ES2022, NodeNext, strict, no declarations/sourcemaps)
- [ ] 1.3 Create `jest.config.js` (ESM support, ts-jest, 80% coverage thresholds)
- [ ] 1.4 Create `.eslintrc.json` (mirror cdk-grafana-resources)
- [ ] 1.5 Create `.prettierrc` (mirror cdk-grafana-resources)
- [ ] 1.6 Create `.gitignore` (`node_modules/`, `dist/`, `*.tsbuildinfo`, `coverage/`)
- [ ] 1.7 Run `npm install` — verify clean install, no audit failures

## Phase 2 — Implementation ([02-implementation.md](02-implementation.md))

- [ ] 2.1 Create `src/index.ts`:
  - [ ] Startup: validate `MCP_SERVER_URL` is present
  - [ ] Startup: reject `NODE_TLS_REJECT_UNAUTHORIZED=0`
  - [ ] Startup: enforce `https://` scheme only (blocks `http://`, `file://`, `ftp://`)
  - [ ] Signer: configure `SignatureV4` with `fromNodeProviderChain()`, region, service, explicit `Sha256`
  - [ ] Stdin: readline interface with sequential promise queue (no concurrent fetches)
  - [ ] Input validation: parse JSON, reject non-JSON-RPC, extract request `id`
  - [ ] Signing: build `HttpRequest`, sign, forward via `fetch`
  - [ ] Response (JSON): validate body is JSON before forwarding
  - [ ] Response (SSE): parse `data:` lines, validate each is JSON, enforce 1 MB buffer cap
  - [ ] Errors: sanitize HTTP error bodies (log full to stderr, status-only to stdout), echo request `id`
  - [ ] Errors: catch network/signing failures, emit JSON-RPC error
  - [ ] SSE overflow: emit JSON-RPC error to client on buffer limit breach
  - [ ] Shutdown: handle `SIGTERM`, `SIGINT`, stdin `close`; drain in-flight requests before exit
- [ ] 2.2 Run `npm run build` — verify shebang is prepended to `dist/index.js`

## Phase 3 — Testing ([03-testing.md](03-testing.md))

- [ ] 3.1 Create `test/index.test.ts`:
  - [ ] Startup: missing `MCP_SERVER_URL` exits 1
  - [ ] Startup: `http://` URL rejected
  - [ ] Startup: `file://` URL rejected
  - [ ] Startup: `ftp://` URL rejected
  - [ ] Startup: `NODE_TLS_REJECT_UNAUTHORIZED=0` exits 1
  - [ ] Input: valid JSON-RPC signed and forwarded
  - [ ] Input: non-JSON ignored, stderr warning
  - [ ] Input: JSON without `jsonrpc: "2.0"` ignored, stderr warning
  - [ ] Input: empty lines silently skipped
  - [ ] Signing: `Authorization` and `X-Amz-Date` headers present
  - [ ] Signing: `host` header matches URL hostname
  - [ ] Response: 200 JSON body forwarded as single line
  - [ ] Response: 200 non-JSON body dropped, stderr warning
  - [ ] Response: 200 SSE `data:` lines forwarded individually
  - [ ] Response: SSE non-JSON data dropped, stderr warning
  - [ ] Response: SSE buffer overflow aborted, JSON-RPC error emitted
  - [ ] Error: HTTP 403 — sanitized error on stdout, full body on stderr
  - [ ] Error: HTTP 500 — same behavior as 403
  - [ ] Error: network failure — JSON-RPC error on stdout, details on stderr
  - [ ] Error: response echoes original request `id`
  - [ ] Error: notification (no `id`) gets `id: null`
  - [ ] Sequential: multiple rapid lines produce in-order responses
  - [ ] Shutdown: stdin close drains in-flight requests
  - [ ] Shutdown: SIGTERM closes readline, drains requests
- [ ] 3.2 Run `npm test` — all tests pass, coverage >= 80% on branches/functions/lines/statements

## Phase 4 — CI & Release ([04-ci-release.md](04-ci-release.md))

- [ ] 4.1 Create `.github/workflows/ci.yml` (triggers on PRs to `main`, runs lint/build/test)
- [ ] 4.2 Create `.github/workflows/release.yml` (tag-triggered, OIDC publish with provenance)
- [ ] 4.3 Create `.github/workflows/dependabot-auto-merge.yml` (auto-squash minor/patch)
- [ ] 4.4 Create `.github/dependabot.yml` (weekly Monday, npm + github-actions, grouped minor/patch)

## Phase 5 — Documentation ([05-documentation.md](05-documentation.md))

- [ ] 5.1 Write `README.md` (description, quick start, env vars table, data flow diagram, security notes, IAM prereqs)
- [ ] 5.2 Write `CONTRIBUTING.md` (prerequisites, dev workflow, release process)
- [ ] 5.3 Write `LICENSE` (Apache-2.0)

## Phase 6 — Rollout ([06-rollout.md](06-rollout.md))

- [ ] 6.1 Push to `github.com/deotio/mcp-sigv4-proxy`
- [ ] 6.2 Configure branch protection on `main` (require CI, require PR)
- [ ] 6.3 First manual `npm publish --access public`
- [ ] 6.4 Configure npm Trusted Publishing (org `deotio`, repo `mcp-sigv4-proxy`, workflow `release.yml`)
- [ ] 6.5 Verify automated release: bump version, tag `v0.1.0`, push, confirm CI publishes
- [ ] 6.6 Update `dot-finops-aws/.mcp.json` to use `npx @deotio/mcp-sigv4-proxy`
- [ ] 6.7 Update `dot-finops-aws/plans/mcp-agentcore-proxy.md`
