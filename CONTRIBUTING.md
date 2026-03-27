# Contributing

## Prerequisites

- Node.js >= 20
- npm

## Development

```bash
npm ci
npm run build
npm test
```

## Linting

```bash
npm run lint
```

## Release process

Releases are automated via GitHub Actions:

1. Bump the version in `package.json`
2. Commit the change
3. Create and push a tag: `git tag v0.x.x && git push --tags`
4. The `release.yml` workflow publishes to npm with provenance
