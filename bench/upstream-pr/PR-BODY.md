### What

`buildNextjsApp` spawns the Next.js build without passing `env`, so the environment variables that `setStandaloneBuildMode` sets one line earlier never reach the child process under Bun. This passes `env: process.env` explicitly.

### Why

`setStandaloneBuildMode` communicates with the Next.js build through `process.env`:

```ts
export function setStandaloneBuildMode(options: buildHelper.BuildOptions) {
  process.env.NEXT_PRIVATE_STANDALONE = "true";
  process.env.NEXT_PRIVATE_OUTPUT_TRACE_ROOT = options.monorepoRoot;
}
```

`buildNextjsApp` then calls `cp.execSync(command, { stdio, cwd })` with no `env`.

Node forwards runtime mutations of `process.env` to the child by default. Bun resolves the child environment from a snapshot taken at startup unless `env` is passed explicitly, so `NEXT_PRIVATE_STANDALONE` never reaches `next build`, standalone output is never produced, and the run fails much later in `createCacheAssets`:

```
ENOENT: no such file or directory, open
  '<app>/.next/standalone/.next/server/pages-manifest.json'
    at getHtmlPages      (@opennextjs/aws/dist/build/helper.js:193)
    at createCacheAssets (@opennextjs/aws/dist/build/createAssets.js:77)
    at build             (@opennextjs/cloudflare/dist/cli/build/build.js:82)
```

The error points at a path inside an empty `.next/standalone/`, several stages away from the cause, which makes this hard to diagnose from the message alone.

### Reproduction

Bare `create-next-app` (App Router, TypeScript, Turbopack), no `output` field in `next.config.ts`:

| # | Adapter runtime | `output` | exit | standalone emitted | `worker.js` |
|---|---|---|---|---|---|
| A | `bunx --bun opennextjs-cloudflare build` | unset | **1** | no | no |
| B | `bunx --bun opennextjs-cloudflare build` | `"standalone"` | 0 | yes | yes |
| C | `npx opennextjs-cloudflare build` | unset | 0 | yes | yes |

With this patch applied to the installed package, case A becomes `exit=0` with standalone and `worker.js` produced, on the same runtime and the same config.

### Isolated runtime behaviour

```js
import { execSync, spawnSync, execFileSync } from "node:child_process";
process.env.PROBE = "true";
execSync('printenv PROBE || echo "(not propagated)"');
spawnSync("printenv", ["PROBE"]);
execFileSync("printenv", ["PROBE"]);
```

| API (no `env` option) | Node v26.4.0 | Bun 1.3.14 |
|---|---|---|
| `execSync` | `true` | not propagated |
| `spawnSync` | `true` | empty |
| `execFileSync` | `true` | throws |

Passing `env: process.env` makes all three return `true` on Bun as well.

### Relationship to the Bun issue

Related Bun-side behaviour is tracked in [oven-sh/bun#29237](https://github.com/oven-sh/bun/issues/29237) (closed 2026-07-24). That issue is specifically about stale `PATH` resolution in `execFileSync`, so it is adjacent to, not identical with, the propagation of a `process.env` mutation shown above.

The reproduction above was run on **bun 1.3.14**. bun 1.4.0 shipped on 2026-08-20; I have not re-run the reproduction against it, and its release notes do not mention environment propagation, so I cannot say from measurement whether the runtime behaviour changed. That does not affect this change either way: passing `env` explicitly is the workaround recommended in the linked issue, and it costs nothing on Node.

`installDeps.ts` already passes `env` explicitly, so this is the only affected call site I found.

### Environment

The reproduction and the runtime table were measured against the published package, not a build of this branch:

- `@opennextjs/aws` **4.1.0** (installed via `@opennextjs/cloudflare`)
- the patch in this PR applies cleanly to `main` at `3342279`, and the affected call site in `buildNextApp.ts` is unchanged there
- `@opennextjs/cloudflare` 1.20.2
- next 16.3.1
- node v26.4.0 / bun 1.3.14
- macOS 26.5.2, Apple Silicon
