#!/usr/bin/env bash
set -euo pipefail

# Creates the mini-notes-sessions DynamoDB table.
# PAY_PER_REQUEST billing means no capacity planning is needed.

aws dynamodb create-table \
    --table-name "mini-notes-sessions-${STAGE}" \
    --attribute-definitions \
        AttributeName=session_id,AttributeType=S \
    --key-schema \
        AttributeName=session_id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --tags Key=mini-notes,Value=

echo "Table 'mini-notes-sessions-${STAGE}' created. Waiting for it to become active..."
aws dynamodb wait table-exists --table-name "mini-notes-sessions-${STAGE}"

aws dynamodb update-time-to-live \
    --table-name "mini-notes-sessions-${STAGE}" \
    --time-to-live-specification "Enabled=true, AttributeName=ttl_expire"

echo "TTL enabled on 'mini-notes-sessions-${STAGE}' using attribute 'ttl_expire'."
