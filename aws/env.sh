#!/usr/bin/env bash

# Sets environment variables for working with the mini-notes AWS project.
# Must be sourced, not executed:
#   source aws/env.sh
#   . aws/env.sh

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "This script must be sourced, not executed:" >&2
    echo "  source ${0}" >&2
    exit 1
fi

export AWS_PROFILE=mini-notes
export STAGE=dev
