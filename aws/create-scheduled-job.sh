#!/usr/bin/env bash
set -euo pipefail

# Creates a scheduled-job Lambda and its EventBridge Scheduler schedule.
# Run `make zip-<JOB_NAME>` before this script.
#
# Usage:
#   ./aws/create-scheduled-job.sh JOB_NAME SCHEDULE_EXPRESSION
#
# JOB_NAME must include the "job-" prefix (e.g. "job-heartbeat").
# SCHEDULE_EXPRESSION is an EventBridge Scheduler expression, e.g.
#   "rate(1 hour)"       — every hour
#   "cron(0 3 * * ? *)"  — daily at 03:00 UTC
#
# Requires: ${STAGE} env var (see aws/env.sh); the shared lambda role
# mini-notes-lambda-role (create-iam-role.sh); the scheduler role
# mini-notes-scheduler-role-${STAGE} (create-scheduler-role.sh).

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 JOB_NAME SCHEDULE_EXPRESSION" >&2
    echo "  JOB_NAME must start with 'job-' (e.g. job-heartbeat)" >&2
    exit 1
fi

JOB_NAME="$1"
SCHEDULE_EXPR="$2"

if [[ "${JOB_NAME}" != job-* ]]; then
    echo "Error: JOB_NAME must start with 'job-' (got '${JOB_NAME}')." >&2
    exit 1
fi

ARCH=arm64
REGION=$(aws configure get region)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ZIP="target/lambda/${JOB_NAME}/bootstrap.zip"
FUNCTION_NAME="mini-notes-${JOB_NAME}-${STAGE}"
SCHEDULE_NAME="mini-notes-${JOB_NAME}-${STAGE}"
LAMBDA_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/mini-notes-lambda-role"
SCHEDULER_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/mini-notes-scheduler-role-${STAGE}"

if [[ ! -f "${ZIP}" ]]; then
    echo "Error: ${ZIP} not found. Run 'make zip-${JOB_NAME}' first." >&2
    exit 1
fi

# --- Delete any existing schedule and Lambda so this script can re-run ---
# Delete the schedule first so no firings land on a half-replaced Lambda.
# Note: for routine code updates, prefer 'make deploy-${JOB_NAME}' — that only
# updates the function code and leaves the schedule untouched.
if aws scheduler get-schedule --name "${SCHEDULE_NAME}" >/dev/null 2>&1; then
    echo "Deleting existing schedule '${SCHEDULE_NAME}'..."
    aws scheduler delete-schedule --name "${SCHEDULE_NAME}"
fi
if aws lambda get-function --function-name "${FUNCTION_NAME}" >/dev/null 2>&1; then
    echo "Deleting existing Lambda '${FUNCTION_NAME}'..."
    aws lambda delete-function --function-name "${FUNCTION_NAME}"
fi

# --- Create the Lambda function ---
aws lambda create-function \
    --function-name "${FUNCTION_NAME}" \
    --runtime provided.al2023 \
    --handler bootstrap \
    --role "${LAMBDA_ROLE_ARN}" \
    --zip-file "fileb://${ZIP}" \
    --environment "Variables={STAGE=${STAGE},RUST_LOG=info}" \
    --architectures "${ARCH}" \
    --tags mini-notes=

FUNCTION_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"

# --- Create the EventBridge Scheduler schedule ---
aws scheduler create-schedule \
    --name "${SCHEDULE_NAME}" \
    --schedule-expression "${SCHEDULE_EXPR}" \
    --flexible-time-window '{"Mode": "OFF"}' \
    --target "{
        \"Arn\": \"${FUNCTION_ARN}\",
        \"RoleArn\": \"${SCHEDULER_ROLE_ARN}\",
        \"Input\": \"{\\\"job\\\": \\\"${JOB_NAME}\\\"}\"
    }"

echo ""
echo "Lambda '${FUNCTION_NAME}' created (${ARCH})."
echo "Schedule '${SCHEDULE_NAME}' created: ${SCHEDULE_EXPR}"
echo ""
echo "Manual invoke:"
echo "  aws lambda invoke --function-name ${FUNCTION_NAME} \\"
echo "      --payload '{\"job\":\"${JOB_NAME}\"}' /tmp/${JOB_NAME}.out"
