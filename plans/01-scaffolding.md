# Phase 1 — Scaffolding

## Steps

1.1. Create `package.json` (see below).
1.2. Create `tsconfig.json` (see below).
1.3. Create `jest.config.js` (ESM-compatible: `extensionsToTreatAsEsm`, `moduleNameMapper` for `.js` -> `.ts`, coverage thresholds).
1.4. Create `.eslintrc.json` (mirror cdk-grafana-resources).
1.5. Create `.prettierrc` (mirror cdk-grafana-resources).
1.6. Create `.gitignore` (`node_modules/`, `dist/`, `*.tsbuildinfo`, `coverage/`).
1.7. Run `npm install`.

## package.json

```json
{
  "name": "@deotio/mcp-sigv4-proxy",
  "version": "0.1.0",
  "description": "stdio MCP proxy with AWS SigV4 signing — connect Claude Code to any IAM-authenticated MCP server using a named AWS profile",
  "type": "module",
  "bin": {
    "mcp-sigv4-proxy": "dist/index.js"
  },
  "main": "dist/index.js",
  "files": ["dist"],
  "scripts": {
    "build": "tsc && node -e \"const fs=require('fs');const f='dist/index.js';fs.writeFileSync(f,'#!/usr/bin/env node\\n'+fs.readFileSync(f));\"",
    "test": "node --experimental-vm-modules node_modules/.bin/jest --coverage",
    "lint": "eslint 'src/**/*.ts' 'test/**/*.ts'",
    "prepublishOnly": "npm run build && npm test"
  },
  "dependencies": {
    "@aws-sdk/credential-providers": "^3.0.0",
    "@aws-crypto/sha256-js": "^5.0.0",
    "@smithy/protocol-http": "^4.0.0",
    "@smithy/signature-v4": "^4.0.0"
  },
  "devDependencies": {
    "@types/jest": "^29.0.0",
    "@types/node": "^22.0.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "eslint": "^8.0.0",
    "jest": "^29.0.0",
    "prettier": "^3.0.0",
    "ts-jest": "^29.0.0",
    "typescript": "^5.0.0"
  },
  "keywords": [
    "mcp", "model-context-protocol", "aws", "sigv4", "agentcore",
    "bedrock", "proxy", "iam", "authentication"
  ],
  "publishConfig": { "access": "public" },
  "engines": { "node": ">=20" },
  "license": "Apache-2.0",
  "homepage": "https://github.com/deotio/mcp-sigv4-proxy#readme",
  "bugs": { "url": "https://github.com/deotio/mcp-sigv4-proxy/issues" },
  "repository": { "type": "git", "url": "https://github.com/deotio/mcp-sigv4-proxy.git" }
}
```

Notes:
- `"type": "module"` — ESM; compiled output gets `.js` extensions in imports via `tsc`.
- `bin` entry makes `npx @deotio/mcp-sigv4-proxy` work directly.
- No peer dependencies — it's a standalone binary.
- `node --experimental-vm-modules` required for Jest + ESM.
- `@aws-crypto/sha256-js` is listed as an **explicit** dependency — do not rely on transitive availability.
- `"files": ["dist"]` — publishes the entire `dist/` directory. This is a CLI binary so `.d.ts` and `.map` files are harmless ballast, but we keep the glob simple.
- The `build` script runs `tsc` then prepends a shebang to `dist/index.js`. `tsc` does not preserve shebangs, so this post-compile step is required for `npx` execution.

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "test", "dist"]
}
```

Notes:
- `declaration`, `declarationMap`, and `sourceMap` are omitted — this is a CLI binary, not a library. Nobody imports it, so `.d.ts` files and source maps add no value.
- Use `NodeNext` module system to match `"type": "module"` in package.json.

## jest.config.js

```js
export default {
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true }],
  },
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
```

The 80% coverage threshold is enforced globally across branches, functions, lines, and statements. The `--coverage` flag in the test script activates collection; jest will fail the run if thresholds are not met.
