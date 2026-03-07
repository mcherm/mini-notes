#!/usr/bin/env bash
set -euo pipefail

# Creates the mini-notes DynamoDB table.
# PAY_PER_REQUEST billing means no capacity planning is needed.

aws dynamodb create-table \
    --table-name "mini-notes-notes-${STAGE}" \
    --attribute-definitions AttributeName=id,AttributeType=S \
    --key-schema AttributeName=id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --tags Key=mini-notes,Value=

echo "Table 'mini-notes-notes-${STAGE}' created."
