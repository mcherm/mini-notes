#!/usr/bin/env bash
set -euo pipefail

# Inserts a sample note into the mini-notes table for testing.
# Safe to run multiple times (put-item overwrites on the same key).

aws dynamodb put-item \
    --table-name "mini-notes-notes-${STAGE}" \
    --item '{
        "user_id": {"S": "Xq3_mK8$pL"},
        "note_id": {"S": "bZ7$nR2_wQ"},
        "version_id": {"N": "1"},
        "title":   {"S": "Hello World"},
        "create_time": {"S": "2026-03-08T20:28:54.000Z"},
        "modify_time": {"S": "2026-03-08T20:28:54.000Z"},
        "format": {"S": "PlainText"},
        "body":    {"S": "My first note."}
    }'

echo "Seeded note 'bZ7\$nR2_wQ' into 'mini-notes-notes-${STAGE}'."
