# Deploy Bench — reproduction repository

This is the evidence side of [Deploy Bench](https://github.com/wxxw1xwwx-beep/deploy-bench). Every number that appears in an article or a video is produced by something in this folder and written to `results/` as a raw log. If a claim has no log here, it should not be in the published material, and you are welcome to hold me to that.

Written by Taiga Kudo. One person, one machine, no sponsorship from any host measured here.

## What is in here

| Path | What it is |
|---|---|
| `RUN-001.md` | The first run, written up in full: environment, results, the two hypotheses that were wrong, and what the run does **not** establish |
| `harness.mjs` | The build-time measurement harness. Same repository, same commit, same lockfile for every condition; cold and warm kept as separate numbers |
| `reference-app/` | The reference project every condition is built from. A bare `create-next-app` on Next.js 16, plus the Cloudflare adapter config |
| `results/` | Raw logs and JSON, one file per run, named with the UTC timestamp of the run |
| `repro-opennext-standalone.mjs` | Minimal reproduction of the OpenNext standalone failure |
| `bun-env-probe.mjs` | Nineteen lines that isolate the Bun `child_process` environment-variable behaviour |
| `bun-env-probe-workaround.mjs` | The same probe with `env: process.env` passed explicitly |
| `upstream-pr/` | A one-line patch for `@opennextjs/aws` and the PR body written for it |

## Reproducing RUN-001

The environment RUN-001 was measured on is listed in its §1. Different versions will give different numbers, which is the point of writing them down.

```bash
node bun-env-probe.mjs          # Node: every child process sees the variable
bun bun-env-probe.mjs           # Bun 1.3.14: the children do not
bun bun-env-probe-workaround.mjs # passing env: process.env explicitly fixes it
```

```bash
cd reference-app && bun install
node repro-opennext-standalone.mjs   # reproduces the ENOENT on .next/standalone
```

```bash
node harness.mjs --runs 3       # build timings, written to results/
```

`harness.mjs` deletes `.next/` and `.open-next/` in `reference-app/` between runs. Nothing outside this folder is touched.

## The rules these runs follow

1. One project, deployed everywhere. Same repository, same commit, same lockfile, same content. No host gets a hand-tuned build.
2. Cold and warm stay separate. First byte after a cache purge and first byte on a warm edge are different products, published as two numbers, never averaged into one.
3. No run, no number. A host that has not been deployed to has no verdict attached to it, and no impression of one either.
4. The raw log ships with the claim. If the log is not here, the claim does not go out.

## What this repository does not contain

Deploy-time measurements against commercial hosts. Those need paid accounts, and until an account exists and a deploy has actually run, the host sits in the queue with no number and no opinion attached to it.

## Corrections

If a number here does not reproduce on your machine, open an issue with your environment and your log. A correction to a published figure is worth more to me than the figure was.

## Disclosure

Some links in the articles and videos that cite this repository may be affiliate links, labelled where they appear. Nothing in this folder is affiliate-linked, and the ordering in any comparison comes from the logs in `results/`, not from what a host pays.

## License

The measurement code and logs in this folder are MIT licensed. `reference-app/` is a generated `create-next-app` project and carries its own upstream license.
