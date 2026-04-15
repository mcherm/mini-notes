#!/usr/bin/env bash
set -euo pipefail

# Creates the IAM role that EventBridge Scheduler assumes in order to invoke
# mini-notes scheduled-job Lambdas. Run once per stage before creating any
# scheduled jobs. Stage is taken from the ${STAGE} env var (see aws/env.sh).
#
# The role's invoke permission is scoped to lambda function names matching
# mini-notes-job-*-${STAGE}, relying on the "job-" crate-name convention.

REGION=$(aws configure get region)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ROLE_NAME="mini-notes-scheduler-role-${STAGE}"

# --- Trust policy: allows EventBridge Scheduler to assume this role ---
aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document '{
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "scheduler.amazonaws.com"},
            "Action": "sts:AssumeRole"
        }]
    }' \
    --tags Key=mini-notes,Value=

# --- Invoke permission: limited to mini-notes-job-*-${STAGE} functions ---
aws iam put-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-name invoke-mini-notes-jobs \
    --policy-document "{
        \"Version\": \"2012-10-17\",
        \"Statement\": [{
            \"Effect\": \"Allow\",
            \"Action\": \"lambda:InvokeFunction\",
            \"Resource\": \"arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:mini-notes-job-*-${STAGE}\"
        }]
    }"

echo "Role '${ROLE_NAME}' created."
