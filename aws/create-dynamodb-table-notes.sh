#!/usr/bin/env bash
set -euo pipefail

# Creates the mini-notes-notes DynamoDB table.
# PAY_PER_REQUEST billing means no capacity planning is needed.

aws dynamodb create-table \
    --table-name "mini-notes-notes-${STAGE}" \
    --attribute-definitions \
        AttributeName=user_id,AttributeType=S \
        AttributeName=note_id,AttributeType=S \
        AttributeName=modify_time,AttributeType=S \
    --key-schema \
        AttributeName=user_id,KeyType=HASH \
        AttributeName=note_id,KeyType=RANGE \
    --local-secondary-indexes \
        'IndexName=notes-by-modify-time,KeySchema=[{AttributeName=user_id,KeyType=HASH},{AttributeName=modify_time,KeyType=RANGE}],Projection={ProjectionType=INCLUDE,NonKeyAttributes=[version_id,title,format,delete_time]}' \
    --billing-mode PAY_PER_REQUEST \
    --tags Key=mini-notes,Value=

echo "Table 'mini-notes-notes-${STAGE}' created. Waiting for it to become active..."
aws dynamodb wait table-exists --table-name "mini-notes-notes-${STAGE}"

aws dynamodb update-time-to-live \
    --table-name "mini-notes-notes-${STAGE}" \
    --time-to-live-specification "Enabled=true, AttributeName=ttl_delete"

echo "TTL enabled on 'mini-notes-notes-${STAGE}' using attribute 'ttl_delete'."
