#!/usr/bin/env bash
set -euo pipefail

# Creates the get-note Lambda function, uploads the compiled binary,
# and attaches a public HTTPS Function URL.
# Run `make zip-get-note` before this script.

ARCH=arm64
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ZIP=target/lambda/get-note/bootstrap.zip

if [[ ! -f "${ZIP}" ]]; then
    echo "Error: ${ZIP} not found. Run 'make zip-get-note' first." >&2
    exit 1
fi

aws lambda create-function \
    --function-name "mini-notes-get-note-${STAGE}" \
    --runtime provided.al2023 \
    --handler bootstrap \
    --role "arn:aws:iam::${ACCOUNT_ID}:role/mini-notes-lambda-role" \
    --zip-file "fileb://${ZIP}" \
    --environment "Variables={TABLE_NAME=mini-notes-notes-${STAGE}}" \
    --architectures "${ARCH}" \
    --tags mini-notes=

# Create the Function URL (auth-type NONE = public endpoint)
FUNCTION_URL=$(aws lambda create-function-url-config \
    --function-name "mini-notes-get-note-${STAGE}" \
    --auth-type NONE \
    --query FunctionUrl \
    --output text)

# Grant public unauthenticated invocation access.
# This permission is required even when auth-type is NONE.
aws lambda add-permission \
    --function-name "mini-notes-get-note-${STAGE}" \
    --statement-id function-url-public-access \
    --action lambda:InvokeFunctionUrl \
    --principal "*" \
    --function-url-auth-type NONE

echo ""
echo "Lambda 'mini-notes-get-note-${STAGE}' created (arm64)."
echo "Function URL: ${FUNCTION_URL}"
echo ""
echo "Test with:"
echo "  curl '${FUNCTION_URL}?id=hello-world'"
