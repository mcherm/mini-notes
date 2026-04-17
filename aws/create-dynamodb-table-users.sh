#!/usr/bin/env bash
set -euo pipefail

# Creates the mini-notes-users DynamoDB table.
# PAY_PER_REQUEST billing means no capacity planning is needed.

aws dynamodb create-table \
    --table-name "mini-notes-users-${STAGE}" \
    --attribute-definitions \
        AttributeName=user_id,AttributeType=S \
        AttributeName=email,AttributeType=S \
    --key-schema \
        AttributeName=user_id,KeyType=HASH \
    --global-secondary-indexes \
        'IndexName=users-by-email,KeySchema=[{AttributeName=email,KeyType=HASH}],Projection={ProjectionType=ALL}' \
    --billing-mode PAY_PER_REQUEST \
    --tags Key=mini-notes,Value=

echo "Table 'mini-notes-users-${STAGE}' created. Waiting for it to become active..."
aws dynamodb wait table-exists --table-name "mini-notes-users-${STAGE}"
