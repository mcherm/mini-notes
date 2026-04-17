#!/usr/bin/env bash
set -euo pipefail

# Recreates the mini-notes-notes table by backing up all data, dropping the
# table, recreating it via create-dynamodb-table-notes.sh, and restoring the
# data. Useful when the table schema (e.g. LSI projection) needs to change.
#
# Usage:
#   source aws/env.sh
#   STAGE=dev ./aws/recreate-notes-table.sh
#   STAGE=prod ./aws/recreate-notes-table.sh

if [[ -z "${STAGE:-}" ]]; then
    echo "ERROR: STAGE environment variable must be set (dev or prod)." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TABLE_NAME="mini-notes-notes-${STAGE}"
BACKUP_FILE="/tmp/${TABLE_NAME}-backup.json"

echo "========================================="
echo "  OUTAGE START: ${TABLE_NAME}"
echo "========================================="
echo ""
echo "This script will recreate the table '${TABLE_NAME}'."
echo "The table will be unavailable during this process."
echo ""
read -p "Continue? (yes/no) " CONFIRM
if [[ "${CONFIRM}" != "yes" ]]; then
    echo "Aborted."
    exit 1
fi

# --- Step 1: Download all existing data ---
echo ""
echo "Step 1: Downloading all data from '${TABLE_NAME}'..."

ALL_ITEMS="[]"
SCAN_ARGS=(dynamodb scan --table-name "${TABLE_NAME}" --output json)
NEXT_TOKEN=""

while true; do
    if [[ -n "${NEXT_TOKEN}" ]]; then
        RESULT=$(aws "${SCAN_ARGS[@]}" --starting-token "${NEXT_TOKEN}")
    else
        RESULT=$(aws "${SCAN_ARGS[@]}")
    fi

    PAGE_ITEMS=$(echo "${RESULT}" | jq -c '.Items')
    ALL_ITEMS=$(echo "${ALL_ITEMS}" "${PAGE_ITEMS}" | jq -s '.[0] + .[1]')

    NEXT_TOKEN=$(echo "${RESULT}" | jq -r '.NextToken // empty')
    if [[ -z "${NEXT_TOKEN}" ]]; then
        break
    fi
done

echo "${ALL_ITEMS}" > "${BACKUP_FILE}"
ITEM_COUNT=$(echo "${ALL_ITEMS}" | jq 'length')
echo "Downloaded ${ITEM_COUNT} items to ${BACKUP_FILE}."

# --- Step 2: Delete the existing table ---
echo ""
echo "Step 2: Deleting table '${TABLE_NAME}'..."
aws dynamodb delete-table --table-name "${TABLE_NAME}" > /dev/null
echo "Waiting for table deletion to complete..."
aws dynamodb wait table-not-exists --table-name "${TABLE_NAME}"
echo "Table deleted."

# --- Step 3: Recreate the table (including TTL) ---
echo ""
echo "Step 3: Recreating table '${TABLE_NAME}'..."
"${SCRIPT_DIR}/create-dynamodb-table-notes.sh"

# --- Step 4: Restore data ---
echo ""
echo "Step 4: Restoring ${ITEM_COUNT} items to '${TABLE_NAME}'..."

BATCH_SIZE=25
OFFSET=0

while [[ "${OFFSET}" -lt "${ITEM_COUNT}" ]]; do
    BATCH=$(echo "${ALL_ITEMS}" | jq -c "[.[${OFFSET}:${OFFSET}+${BATCH_SIZE}][] | {PutRequest: {Item: .}}]")
    REQUEST_ITEMS=$(jq -n --arg table "${TABLE_NAME}" --argjson items "${BATCH}" '{($table): $items}')

    aws dynamodb batch-write-item --request-items "${REQUEST_ITEMS}" > /dev/null

    OFFSET=$((OFFSET + BATCH_SIZE))
    RESTORED=$((OFFSET < ITEM_COUNT ? OFFSET : ITEM_COUNT))
    echo "  Restored ${RESTORED}/${ITEM_COUNT} items..."
done

echo "All items restored."

# --- Done ---
echo ""
echo "========================================="
echo "  OUTAGE END: ${TABLE_NAME}"
echo "========================================="
echo ""
echo "Backup file retained at: ${BACKUP_FILE}"
echo "You may delete it after verifying the table contents."
