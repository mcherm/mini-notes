#!/usr/bin/env bash
set -euo pipefail

# Creates all mini-notes scheduled background jobs for ${STAGE}. This file is
# the source of truth for which jobs exist and how often they run; to change a
# schedule, edit the matching line here and commit it.
#
# Workflow to reset to declared state:
#   1. Manually delete existing job schedules and Lambda functions (see
#      docs or run the per-resource aws CLI commands).
#   2. Run this script.
#
# Prerequisites:
#   - source aws/env.sh  (sets STAGE)
#   - aws/create-scheduler-role.sh has been run once for this stage
#   - `make zip` has been run so all job binaries are packaged

# ─── Heartbeat ────────────────────────────────────────────────────────────────
# Trivial job that logs a line. Proves the scheduled-job wiring is working
# end-to-end. Safe to leave running in prod.
./aws/create-scheduled-job.sh job-heartbeat "rate(1 hour)"
