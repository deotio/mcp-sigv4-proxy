# Phase 6 — Rollout

## Steps

6.1. Push to `github.com/deotio/mcp-sigv4-proxy`.
6.2. Configure branch protection on `main`: require CI to pass, require PR.
6.3. **First publish — must be done manually via CLI** (npmjs.com Trusted Publishing cannot be configured for a package that doesn't exist yet):
    ```bash
    npm run build
    npm publish --access public
    ```
    Log in first with `npm login` if needed. This creates the `@deotio/mcp-sigv4-proxy` package on npmjs.com.
6.4. After first publish, configure **npm Trusted Publishing** on npmjs.com:
    - Package settings -> Publishing -> Trusted Publishers
    - Add GitHub Actions publisher: org `deotio`, repo `mcp-sigv4-proxy`, workflow `release.yml`
    - This enables OIDC-based publish in CI without storing `NPM_TOKEN`.
6.5. All subsequent releases are automated: bump version -> commit -> `git tag v0.x.x` -> push tag -> CI publishes.

## Consume in dot-finops-aws

6.6. Update `dot-finops-aws/.mcp.json` to replace the local proxy path with `npx @deotio/mcp-sigv4-proxy`.
6.7. Update `dot-finops-aws/plans/mcp-agentcore-proxy.md` to reflect the published package approach.
