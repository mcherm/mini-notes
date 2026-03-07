#!/usr/bin/env bash
set -euo pipefail

# Inserts a sample note into the mini-notes table for testing.
# Safe to run multiple times (put-item overwrites on the same key).

aws dynamodb put-item \
    --table-name "mini-notes-notes-${STAGE}" \
    --item '{
        "id":      {"S": "hello-world"},
        "title":   {"S": "Hello World"},
        "content": {"S": "My first note."}
    }'

echo "Seeded note 'hello-world' into 'mini-notes-notes-${STAGE}'."
