# AWS Setup

Scripts for creating the AWS resources that back mini-notes.
Run them once, in order, for initial setup.

## Prerequisites

Install the [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html),
then configure a named profile for this project:

```bash
aws configure --profile mini-notes
# Prompts for: Access Key ID, Secret Access Key, region (e.g. us-east-1), output format
```

Verify it works:

```bash
source aws/env.sh
aws sts get-caller-identity
# Should print your account ID, user ID, and ARN
```

## Scripts

| Script | Run | Description |
|---|---|---|
| `env.sh` | Each session | **Source** this to set `AWS_PROFILE=mini-notes` and `STAGE=dev` |
| `create-dynamodb-table.sh` | Once per stage | Creates the `mini-notes-notes-<stage>` DynamoDB table |
| `create-iam-role.sh` | Once (shared) | Creates the Lambda execution role; not stage-specific |
| `create-lambda-api-v1.sh` | Once per stage | Creates the `mini-notes-api-v1-<stage>` Lambda and attaches a public HTTPS Function URL |
| `create-cors-policy.sh` | Once per stage | Creates a CloudFront response headers policy for CORS, allowing the frontend domain to call the API |
| `create-cloudfront-distribution.sh` | Once per stage | Creates a CloudFront distribution with S3 (static frontend) and Lambda origins, custom domains, TLS, and CORS policy |
| `upload-static-assets.sh` | On frontend changes | Syncs `html/` to the S3 frontend bucket for the current stage |
| `seed-test-data.sh` | As needed | Inserts a sample note into the current stage's DynamoDB table |

## Initial setup sequence

```bash
# From the repo root:

source aws/env.sh   # sets AWS_PROFILE=mini-notes and STAGE=dev; do this once per shell session
chmod +x aws/*.sh

./aws/create-dynamodb-table.sh  # creates mini-notes-notes-dev
./aws/create-iam-role.sh        # creates shared role (run once, not per stage)

make zip-api-v1                    # build binary and package it
./aws/create-lambda-api-v1.sh     # creates Lambda + Function URL; prints the invoke URL

./aws/create-cors-policy.sh       # creates CORS response headers policy for CloudFront

./aws/seed-test-data.sh
```

## Testing

```bash
# Replace <url-id> and <region> with the values printed by create-lambda-api-v1.sh
curl "https://<url-id>.lambda-url.<region>.on.aws/api/v1/notes/hello-world"
# → {"note":{"id":"hello-world","title":"Hello World","content":"My first note."}}

curl "https://<url-id>.lambda-url.<region>.on.aws/api/v1/notes/missing"
# → {"error":"note not found"}   (HTTP 404)
```

## Stages (dev and prod)

`env.sh` sets `STAGE=dev` by default, so all scripts and `make` targets operate on dev
resources unless you explicitly override it. This makes it impossible to accidentally
affect prod during normal development.

**When `STAGE=prod` is required:**

- Setting up prod infrastructure for the first time (run `create-dynamodb-table.sh` and `create-lambda-api-v1.sh` with `STAGE=prod`)
- Deploying a release build to prod (`make deploy` with `STAGE=prod`)
- Seeding or inspecting prod data

In all these cases, override `STAGE` in your shell before running the relevant
command — do not permanently change `env.sh`:

```bash
source aws/env.sh          # sets STAGE=dev as usual

# One-time: set up prod infrastructure
STAGE=prod ./aws/create-dynamodb-table.sh
STAGE=prod ./aws/create-lambda-api-v1.sh

# Deploy a release to prod
STAGE=prod make deploy
```

The `STAGE=prod` prefix overrides the env var for that single command only, leaving
your shell defaulting to dev for everything else.

## Ongoing deployments

After code changes, update the Lambda with a single make target:

```bash
make deploy-api-v1            # build + zip + upload api-v1 to dev
STAGE=prod make deploy-api-v1 # same, targeting prod

make deploy                   # build + zip + upload all lambdas to dev
STAGE=prod make deploy        # same, targeting prod
```
