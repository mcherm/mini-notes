#!/usr/bin/env bash
set -euo pipefail

# Creates the IAM execution role for the mini-notes Lambda functions.
# Grants:
#   - CloudWatch Logs access (via AWS managed policy)
#   - dynamodb:GetItem on the mini-notes table (inline policy)

REGION=$(aws configure get region)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# --- Trust policy: allows Lambda to assume this role ---
aws iam create-role \
    --role-name mini-notes-lambda-role \
    --assume-role-policy-document '{
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "lambda.amazonaws.com"},
            "Action": "sts:AssumeRole"
        }]
    }' \
    --tags Key=mini-notes,Value=

# --- CloudWatch Logs (write Lambda logs) ---
aws iam attach-role-policy \
    --role-name mini-notes-lambda-role \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# --- DynamoDB access (shared by all mini-notes lambdas) ---
aws iam put-role-policy \
    --role-name mini-notes-lambda-role \
    --policy-name dynamodb-access-mini-notes \
    --policy-document "{
        \"Version\": \"2012-10-17\",
        \"Statement\": [{
            \"Effect\": \"Allow\",
            \"Action\": [
                \"dynamodb:GetItem\",
                \"dynamodb:PutItem\",
                \"dynamodb:UpdateItem\",
                \"dynamodb:DeleteItem\",
                \"dynamodb:Query\"
            ],
            \"Resource\": \"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/mini-notes-*\"
        }]
    }"

echo "Role 'mini-notes-lambda-role' created."
