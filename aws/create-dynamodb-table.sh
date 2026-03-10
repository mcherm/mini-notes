#!/usr/bin/env bash
set -euo pipefail

# Creates the mini-notes DynamoDB table.
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
        'IndexName=notes-by-modify-time,KeySchema=[{AttributeName=user_id,KeyType=HASH},{AttributeName=modify_time,KeyType=RANGE}],Projection={ProjectionType=INCLUDE,NonKeyAttributes=[version_id,title,format]}' \
    --billing-mode PAY_PER_REQUEST \
    --tags Key=mini-notes,Value=

echo "Table 'mini-notes-notes-${STAGE}' created."
