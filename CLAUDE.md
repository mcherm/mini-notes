# Mini-Notes

Personal web app for storing/editing notes. Plain HTML/JS frontend, Rust Lambda backend, DynamoDB storage. Deployed on AWS.

## Build & Deploy

```bash
just build          # arm64 Linux binary, built in a container
just zip            # package for Lambda
just deploy         # deploy STAGE (dev or prod; required, set by `source ./aws/env.sh`)
```

Run `just` (or `just --list`) to see all recipes. Each lambda has its own targets, e.g. `just build-api-v1`, `just zip-api-v1`, `just deploy-api-v1`.

The justfile recipes are thin wrappers around bash scripts in `scripts/` (see `scripts/README.md`),
which also work when run directly. The build and deploy constants live in those scripts.
`aws/` holds the one-time AWS provisioning scripts.

Builds run `cargo build` inside an arm64 Linux container (`BUILD_IMAGE` in `scripts/build-lambda.sh`),
which matches Lambda's OS, so nothing is cross-compiled. **This requires an arm64 build
host** (Apple Silicon); building on an x86 Mac is not supported. The build needs the
**Docker daemon running**; the script checks and fails fast with guidance if it isn't.

`BUILD_IMAGE` is pinned to `rust:1-bullseye` (glibc 2.31) because the `provided.al2023`
runtime has glibc 2.34 and glibc is not forward compatible. A newer base image compiles
and deploys without complaint, then fails at Lambda init — keep the image's glibc at or
below 2.34.

Container builds use `target/container/` so their Linux artifacts don't collide with the
macOS ones `cargo test` writes to `target/`.

Requires `just` (`cargo install just`), a running Docker daemon, and the AWS CLI. A host
Rust toolchain is needed for `just test-rust` and `just lint-rust`, `node` for
`just test-js`, [Biome](https://biomejs.dev/) (`brew install biome`) for `just lint-web`, and
[ShellCheck](https://www.shellcheck.net/) (`brew install shellcheck`) for `just lint-scripts`.

## Key Details

- Lambda function name: `mini-notes-api-v1-<stage>` (dev/prod)
- DynamoDB table: `mini-notes-notes-<stage>`, primary key `id` (String)
- Table name set via `TABLE_NAME` env var on the Lambda
- Domains: `mini-notes.com` (prod), `dev.mini-notes.com` (dev); `api.mini-notes.com` / `dev-api.mini-notes.com` for API

## Frontend Layout

`html/` holds the pages, their entry-point scripts (`main.js`, `admin.js`, `reset-password.js`) and `sw.js`. Modules live in `html/lib/`, `html/model/`, `html/data/` and `html/app/`; each directory's `README.txt` describes what belongs there and what it may import.

## Coding Standards
- Instead of customizing div or span elements, we create custom elements (with "-" in the name)
- Most layout is handled using flex or grid
- Instead of using inline lambdas when registering a listener, we create functions whose name begins with "action"

## Documentation Standards
- Design documents in `docs/` describe *what* the design is, with minimal (or no) explanation of *why*. At most a brief clause of justification (e.g. a short "accepted limitation" note); rationale belongs in discussion, not the doc.
