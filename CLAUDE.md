# Mini-Notes

Personal web app for storing/editing notes. Plain HTML/JS frontend, Rust Lambda backend, DynamoDB storage. Deployed on AWS.

## Build & Deploy

```bash
make build          # cargo-lambda, ARM64 target
make zip            # package for Lambda
make deploy         # deploy to dev (STAGE=prod make deploy for prod)
```

Requires `cargo-lambda` (`cargo install cargo-lambda`).

## Project Structure

- `lambdas/api-v1/src/main.rs` — single Lambda handling all API endpoints via path-based routing
- `html/` — static frontend (served from S3 via CloudFront)
- `aws/` — infrastructure setup scripts (source `aws/env.sh` first)
- `docs/design_notes.md` — planned API endpoints and data structures

## Key Details

- Lambda function name: `mini-notes-api-v1-<stage>` (dev/prod)
- DynamoDB table: `mini-notes-notes-<stage>`, primary key `id` (String)
- Table name set via `TABLE_NAME` env var on the Lambda
- Domains: `mini-notes.com` (prod), `dev.mini-notes.com` (dev); `api.mini-notes.com` / `dev-api.mini-notes.com` for API
- Rust edition 2024; dependencies: `lambda_http`, `aws-sdk-dynamodb`, `aws-config`, `tokio`, `serde_json` (all v1)
- Only GET `/api/v1/notes/{note_id}` is implemented so far; no auth yet

## Coding Standards
- Instead of customizing div or span elements, we create custom elements (with "-" in the name)
- Most layout is handled using flex or grid
- Instead of using inline lambdas when registering a listener, we create functions whose name begins with "action"
