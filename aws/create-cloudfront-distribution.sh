#!/usr/bin/env bash
set -euo pipefail

# Creates a CloudFront distribution for mini-notes with:
#   - S3 origin (static frontend) served at /* with standard caching
#   - Lambda Function URL origin served at /api/* with no caching
#   - Custom domains mini-notes.com and api.mini-notes.com
#   - ACM wildcard certificate for *.mini-notes.com
#
# Source aws/env.sh before running this script.

BUCKET="mini-notes-frontend-${STAGE}"
AWS_REGION=$(aws configure get region)

# Returns the bare domain (no https:// or trailing slash) for a Lambda Function URL.
get_lambda_domain() {
    local name="$1"
    local url
    url=$(aws lambda get-function-url-config \
        --function-name "${name}" \
        --query FunctionUrl \
        --output text)
    url="${url#https://}"
    url="${url%/}"
    echo "${url}"
}

API_LAMBDA_DOMAIN=$(get_lambda_domain "mini-notes-api-v1-${STAGE}")

# ACM wildcard certificate for *.mini-notes.com (must be in us-east-1 for CloudFront)
CERT_ARN="arn:aws:acm:us-east-1:402673111584:certificate/ec6c73a5-1aa8-46bf-9e60-4d9a281c3d95"

# Domain aliases and OAC vary by stage
if [[ "${STAGE}" == "prod" ]]; then
    FRONTEND_DOMAIN="mini-notes.com"
    API_DOMAIN="api.mini-notes.com"
    CLOUDFRONT_OAC_ID="E1ZDVQPXNP6U72"
else
    FRONTEND_DOMAIN="dev.mini-notes.com"
    API_DOMAIN="dev-api.mini-notes.com"
    CLOUDFRONT_OAC_ID="E3ERIE4CI441CV"
fi


echo "Creating CloudFront distribution..."
echo "  S3 bucket:    ${BUCKET}"
echo "  Lambda (api-v1): ${API_LAMBDA_DOMAIN}"
echo "  Domains:      ${FRONTEND_DOMAIN}, ${API_DOMAIN}"
echo "  ACM cert:     ${CERT_ARN}"
echo "  OAC ID:       ${CLOUDFRONT_OAC_ID}"
echo ""

# Managed cache/request policy IDs (AWS-provided, identical in all accounts and regions):
#   CachingDisabled           4135ea2d-6df8-44a3-9df3-4b5a84be39ad
#   CachingOptimized          658327ea-f89d-4fab-a63d-7e88639e58f6
#   AllViewerExceptHostHeader b689b0a8-53d0-40ab-baf2-68738e2966ac  (origin request policy)

# CORS response headers policy (created by create-cors-policy.sh)
CORS_POLICY_ID=$(cat "aws/.cors-policy-id-${STAGE}")

CALLER_REF="mini-notes-${STAGE}-$(date +%s)"

DIST_CONFIG_WITH_TAGS=$(cat <<EOF
{
  "DistributionConfig": {
    "CallerReference": "${CALLER_REF}",
    "Aliases": {
      "Quantity": 2,
      "Items": ["${FRONTEND_DOMAIN}", "${API_DOMAIN}"]
    },
    "DefaultRootObject": "index.html",
    "Origins": {
      "Quantity": 2,
      "Items": [
        {
          "Id": "s3-frontend",
          "DomainName": "${BUCKET}.s3.${AWS_REGION}.amazonaws.com",
          "S3OriginConfig": { "OriginAccessIdentity": "" },
          "OriginAccessControlId": "${CLOUDFRONT_OAC_ID}"
        },
        {
          "Id": "lambda-api-v1",
          "DomainName": "${API_LAMBDA_DOMAIN}",
          "CustomOriginConfig": {
            "HTTPPort": 80,
            "HTTPSPort": 443,
            "OriginProtocolPolicy": "https-only",
            "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] }
          }
        }
      ]
    },
    "DefaultCacheBehavior": {
      "TargetOriginId": "s3-frontend",
      "ViewerProtocolPolicy": "redirect-to-https",
      "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
      "Compress": true,
      "AllowedMethods": {
        "Quantity": 2,
        "Items": ["GET", "HEAD"],
        "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
      }
    },
    "CacheBehaviors": {
      "Quantity": 1,
      "Items": [
        {
          "PathPattern": "/api/*",
          "TargetOriginId": "lambda-api-v1",
          "ViewerProtocolPolicy": "redirect-to-https",
          "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac",
          "ResponseHeadersPolicyId": "${CORS_POLICY_ID}",
          "AllowedMethods": {
            "Quantity": 7,
            "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
            "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
          },
          "Compress": true
        }
      ]
    },
    "Comment": "mini-notes ${STAGE}",
    "PriceClass": "PriceClass_100",
    "Enabled": true,
    "ViewerCertificate": {
      "ACMCertificateArn": "${CERT_ARN}",
      "SSLSupportMethod": "sni-only",
      "MinimumProtocolVersion": "TLSv1.2_2021"
    }
  },
  "Tags": {
    "Items": [{ "Key": "mini-notes", "Value": "" }]
  }
}
EOF
)

RESULT=$(aws cloudfront create-distribution-with-tags \
    --distribution-config-with-tags "${DIST_CONFIG_WITH_TAGS}")

DIST_ID=$(echo "${RESULT}"     | python3 -c "import sys,json; print(json.load(sys.stdin)['Distribution']['Id'])")
DIST_DOMAIN=$(echo "${RESULT}" | python3 -c "import sys,json; print(json.load(sys.stdin)['Distribution']['DomainName'])")

# Save distribution ID for use by 'make upload-frontend' (cache invalidation)
echo "${DIST_ID}" > "aws/.cloudfront-dist-id-${STAGE}"

echo "CloudFront distribution created!"
echo "  Distribution ID:   ${DIST_ID}"
echo "  CloudFront domain: ${DIST_DOMAIN}"
echo "  (saved to aws/.cloudfront-dist-id-${STAGE})"
echo ""
echo "Next: create Route 53 alias records pointing ${FRONTEND_DOMAIN}"
echo "  and ${API_DOMAIN} to ${DIST_DOMAIN}"
echo ""
echo "Note: the distribution may take 5-15 minutes to fully deploy globally."
