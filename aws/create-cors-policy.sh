#!/usr/bin/env bash
set -euo pipefail

# Creates a CloudFront response headers policy for CORS on the mini-notes API.
# This allows the frontend domain to make cross-origin requests to the API domain.
#
# Source aws/env.sh before running this script.
# Run once per stage; the policy persists independently of the distribution.

if [[ "${STAGE}" == "prod" ]]; then
    ALLOWED_ORIGIN="https://mini-notes.com"
else
    ALLOWED_ORIGIN="https://dev.mini-notes.com"
fi

POLICY_NAME="mini-notes-cors-${STAGE}"

echo "Creating CloudFront response headers policy..."
echo "  Policy name:    ${POLICY_NAME}"
echo "  Allowed origin: ${ALLOWED_ORIGIN}"
echo ""

POLICY_CONFIG=$(cat <<EOF
{
  "Name": "${POLICY_NAME}",
  "Comment": "CORS policy for mini-notes ${STAGE} API",
  "CorsConfig": {
    "AccessControlAllowOrigins": {
      "Quantity": 1,
      "Items": ["${ALLOWED_ORIGIN}"]
    },
    "AccessControlAllowMethods": {
      "Quantity": 7,
      "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    },
    "AccessControlAllowHeaders": {
      "Quantity": 2,
      "Items": ["Content-Type", "Authorization"]
    },
    "AccessControlAllowCredentials": false,
    "AccessControlMaxAgeSec": 86400,
    "OriginOverride": true
  }
}
EOF
)

RESULT=$(aws cloudfront create-response-headers-policy \
    --response-headers-policy-config "${POLICY_CONFIG}")

POLICY_ID=$(echo "${RESULT}" | python3 -c "import sys,json; print(json.load(sys.stdin)['ResponseHeadersPolicy']['Id'])")

# Save policy ID for use by create-cloudfront-distribution.sh
echo "${POLICY_ID}" > "aws/.cors-policy-id-${STAGE}"

echo "Response headers policy created!"
echo "  Policy ID: ${POLICY_ID}"
echo "  (saved to aws/.cors-policy-id-${STAGE})"
echo ""
echo "Next: attach this policy to the /api/* cache behavior in the CloudFront distribution."
echo "  You can do this in the console: Distributions > Behaviors > edit /api/* > Response headers policy > ${POLICY_NAME}"
