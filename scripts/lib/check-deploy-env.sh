#!/usr/bin/env bash

# Verifies the environment for a deploy, exiting with guidance if it is wrong.
# Sourced (not executed) by the deploy scripts, before they touch AWS:
#   source scripts/lib/check-deploy-env.sh
#
# `source ./aws/env.sh` sets both variables checked here. Without AWS_PROFILE,
# deploys hit the wrong account and fail with a confusing "Function not found".

if [ "${AWS_PROFILE:-}" != "mini-notes" ]; then
    echo "AWS_PROFILE is not 'mini-notes' (currently: '${AWS_PROFILE:-<unset>}')." >&2
    echo "Deploys would target the wrong AWS account. First run:  source ./aws/env.sh" >&2
    exit 1
fi

case "${STAGE:-}" in
    dev | prod) ;;
    *)
        echo "STAGE must be 'dev' or 'prod' (currently: '${STAGE:-<unset>}')." >&2
        echo "First run:  source ./aws/env.sh   (sets STAGE=dev; use STAGE=prod to target prod)" >&2
        exit 1
        ;;
esac
