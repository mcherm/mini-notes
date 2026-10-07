# Scripts

General-purpose project scripts. Most are run through the `justfile`, but each
also works when run directly, from any directory. (Scripts for one-time AWS
provisioning live in `aws/` instead.)

| Script | Run via | Description |
|---|---|---|
| `build-lambda.sh LAMBDA` | `just build-<lambda>` | Builds one lambda in an arm64 Linux container; writes `target/lambda/<LAMBDA>/bootstrap` |
| `package-lambda.sh LAMBDA` | `just zip-<lambda>` | Builds one lambda and zips it to `target/lambda/<LAMBDA>/bootstrap.zip` |
| `deploy-lambda.sh LAMBDA` | `just deploy-<lambda>` | Builds, packages, and uploads one lambda for `STAGE`; skips if sources are unchanged |
| `stage-frontend.sh` | `just stage-frontend` | Assembles the deployable frontend in `target/frontend-staging` (copy of `html/` with `sw.js` stamped) |
| `deploy-frontend.sh` | `just deploy-frontend` | Stages the frontend, uploads it to S3 for `STAGE`, and invalidates CloudFront; skips if `html/` is unchanged |
| `fix-committer.sh` | directly | Repairs jj commits that have lost their committer information |
| `lib/check-deploy-env.sh` | sourced | Checks that `AWS_PROFILE` is `mini-notes` and `STAGE` is `dev` or `prod`; used by the deploy scripts |

The deploy scripts require `STAGE` and `AWS_PROFILE`, both set by
`source ./aws/env.sh`. `STAGE` has no default.

Path constants shared by several scripts (`LAMBDA_DIR`, `SENTINELS`,
`FRONTEND_STAGING`) are defined in each script that uses them, with a comment
naming the other files that define the same constant.
