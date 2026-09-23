# Mini-Notes

Personal web app for storing/editing notes. Plain HTML/JS frontend, Rust Lambda backend, DynamoDB storage. Deployed on AWS.

## Build & Deploy

```bash
just build          # arm64 Linux binary, built in a container
just zip            # package for Lambda
just deploy         # deploy to dev (STAGE=prod just deploy for prod)
```

Run `just` (or `just --list`) to see all recipes. Each lambda has its own targets, e.g. `just build-api-v1`, `just zip-api-v1`, `just deploy-api-v1`.

Builds run `cargo build` inside an arm64 Linux container (`BUILD_IMAGE` in the justfile),
which matches Lambda's OS, so nothing is cross-compiled. **This requires an arm64 build
host** (Apple Silicon); building on an x86 Mac is not supported. The build needs the
**Docker daemon running**; the recipe checks and fails fast with guidance if it isn't.

`BUILD_IMAGE` is pinned to `rust:1-bullseye` (glibc 2.31) because the `provided.al2023`
runtime has glibc 2.34 and glibc is not forward compatible. A newer base image compiles
and deploys without complaint, then fails at Lambda init — keep the image's glibc at or
below 2.34.

Container builds use `target/container/` so their Linux artifacts don't collide with the
macOS ones `cargo test` writes to `target/`.

Requires `just` (`cargo install just`), a running Docker daemon, and the AWS CLI. A host

## Key Details

- Lambda function name: `mini-notes-api-v1-<stage>` (dev/prod)
- DynamoDB table: `mini-notes-notes-<stage>`, primary key `id` (String)
- Table name set via `TABLE_NAME` env var on the Lambda
- Domains: `mini-notes.com` (prod), `dev.mini-notes.com` (dev); `api.mini-notes.com` / `dev-api.mini-notes.com` for API

## Coding Standards
- Instead of customizing div or span elements, we create custom elements (with "-" in the name)
- Most layout is handled using flex or grid
- Instead of using inline lambdas when registering a listener, we create functions whose name begins with "action"

## Documentation Standards
- Design documents in `docs/` describe *what* the design is, with minimal (or no) explanation of *why*. At most a brief clause of justification (e.g. a short "accepted limitation" note); rationale belongs in discussion, not the doc.
