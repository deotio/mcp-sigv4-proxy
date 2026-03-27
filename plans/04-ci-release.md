# Phase 4 — CI & Release

## Steps

4.1. Create `.github/workflows/ci.yml`.
4.2. Create `.github/workflows/release.yml`.
4.3. Create `.github/workflows/dependabot-auto-merge.yml`.
4.4. Create `.github/dependabot.yml`.

## `.github/workflows/ci.yml`

Triggers on PRs to `main` (not `master` — matches this repo's default branch).

```yaml
name: CI
on:
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npm audit --audit-level=high
      - run: npm run lint
      - run: npm run build
      - run: npm test
```

## `.github/workflows/release.yml`

Tag-triggered npm publish with OIDC trusted publishing (no `NPM_TOKEN` secret needed after initial setup — see [06-rollout.md](06-rollout.md)).

```yaml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'
      - run: npm install -g npm@latest
      - run: npm ci
      - run: npm audit --audit-level=high
      - run: npm run lint
      - run: npm run build
      - run: npm test
      - run: npm publish --provenance --access public
```

Note: This workflow requires npm Trusted Publishing to be configured on npmjs.com before it will work. The first publish must be done manually (see [06-rollout.md](06-rollout.md)).

## `.github/workflows/dependabot-auto-merge.yml`

Auto-merge minor/patch dependabot PRs after CI passes. Mirror from `cdk-grafana-resources/.github/workflows/dependabot-auto-merge.yml`.

```yaml
name: Dependabot auto-merge
on: pull_request

permissions:
  contents: write
  pull-requests: write

jobs:
  dependabot:
    runs-on: ubuntu-latest
    if: github.actor == 'dependabot[bot]'
    steps:
      - name: Dependabot metadata
        id: metadata
        uses: dependabot/fetch-metadata@v2
        with:
          github-token: "${{ secrets.GITHUB_TOKEN }}"
      - name: Enable auto-merge for minor and patch updates
        if: steps.metadata.outputs.update-type == 'version-update:semver-minor' || steps.metadata.outputs.update-type == 'version-update:semver-patch'
        run: gh pr merge --auto --squash "$PR_URL"
        env:
          PR_URL: ${{ github.event.pull_request.html_url }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## `.github/dependabot.yml`

Weekly npm + GitHub Actions updates, grouped minor/patch.

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    groups:
      minor-and-patch:
        update-types:
          - "minor"
          - "patch"
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    groups:
      minor-and-patch:
        update-types:
          - "minor"
          - "patch"
```
