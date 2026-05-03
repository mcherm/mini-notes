#!/usr/bin/env bash
set -euo pipefail

# Configures SES for the mini-notes password-reset email feature:
#   1. Creates an SES domain identity for mini-notes.com (so the lambda can
#      send from any @mini-notes.com address).
#   2. Adds the DKIM CNAME records to Route 53 to verify the domain.
#   3. Reports the verification check command.
#
# This is a one-time operation. NOT stage-specific — both dev and prod
# Lambdas send from the same domain identity.
#
# After verification succeeds, you must also separately request that AWS
# move the account out of SES sandbox mode. See the comments at the bottom
# of this script.
#
# Prerequisites: aws CLI, jq.

DOMAIN="mini-notes.com"

# --- Step 1: Create the SES domain identity ---
# This causes SES to generate three DKIM tokens used to prove control of the
# domain. The CNAME records below point at AWS-side endpoints derived from
# those tokens; SES considers the domain verified once it can resolve them.
echo "Creating SES domain identity for ${DOMAIN}..."
aws sesv2 create-email-identity --email-identity "${DOMAIN}"

# --- Step 2: Fetch the DKIM tokens ---
echo ""
echo "Fetching DKIM tokens..."
TOKENS=$(aws sesv2 get-email-identity \
    --email-identity "${DOMAIN}" \
    --query "DkimAttributes.Tokens" \
    --output json)
echo "Tokens: ${TOKENS}"

# --- Step 3: Look up the Route 53 hosted zone for the domain ---
echo ""
echo "Looking up Route 53 hosted zone for ${DOMAIN}..."
HOSTED_ZONE_PATH=$(aws route53 list-hosted-zones-by-name \
    --dns-name "${DOMAIN}." \
    --max-items 1 \
    --query "HostedZones[0].Id" \
    --output text)
HOSTED_ZONE_ID="${HOSTED_ZONE_PATH#/hostedzone/}"
echo "Hosted zone ID: ${HOSTED_ZONE_ID}"

# --- Step 4: Build and submit a Route 53 change batch with the DKIM CNAMEs ---
# Each token becomes a CNAME of the form:
#     <token>._domainkey.mini-notes.com  CNAME  <token>.dkim.amazonses.com
# UPSERT means create-or-replace, so re-running this script is safe.
echo ""
echo "Adding DKIM CNAME records to Route 53..."
CHANGE_BATCH=$(echo "${TOKENS}" | jq --arg domain "${DOMAIN}" '{
    Changes: map({
        Action: "UPSERT",
        ResourceRecordSet: {
            Name: ("\(.)._domainkey.\($domain)"),
            Type: "CNAME",
            TTL: 1800,
            ResourceRecords: [{ Value: ("\(.).dkim.amazonses.com") }]
        }
    })
}')
aws route53 change-resource-record-sets \
    --hosted-zone-id "${HOSTED_ZONE_ID}" \
    --change-batch "${CHANGE_BATCH}"

# --- Step 5: Report verification status ---
echo ""
echo "DKIM CNAMEs added. SES will verify the domain once DNS propagates"
echo "(typically within minutes, but may take up to 72 hours)."
echo ""
echo "Check verification status with:"
echo "  aws sesv2 get-email-identity --email-identity ${DOMAIN} \\"
echo "      --query '[VerifiedForSendingStatus, DkimAttributes.Status]'"
echo ""
echo "Wait for DkimAttributes.Status to become SUCCESS."

# ============================================================================
# SES SANDBOX EXIT (separate step; cannot be automated via API)
# ============================================================================
#
# By default, SES accounts are in "sandbox mode": they can only send to
# verified recipient addresses. Mini-notes needs to send password resets to
# arbitrary user-supplied addresses, so production access is required.
#
# To request production access:
#   1. AWS Console → SES service → Account dashboard.
#   2. Find the "Production access" panel and choose "Request production access".
#   3. Fill in the form:
#        Mail type:        Transactional
#        Website URL:      https://mini-notes.com
#        Use case description (suggested copy):
#          "Mini-notes is a personal notes web application. It sends
#           transactional password-reset emails to users who explicitly
#           request them through a 'Forgot Password' flow. No marketing or
#           bulk mail is sent. Sends are rate-limited to one reset email
#           per user per 60 seconds. Bounces and complaints will be handled
#           per AWS guidance."
#        Compliance:       Confirm AWS AUP and Service Terms.
#   4. Submit. AWS typically responds within ~24 hours.
#
# Until production access is granted, password-reset emails to non-verified
# addresses will fail at the SES API call. The send handler logs and returns
# 204 regardless, so the feature works end-to-end for verified test
# addresses from day one and for arbitrary users once sandbox is exited.
#
# To verify a single recipient address (for testing while still in sandbox):
#   aws sesv2 create-email-identity --email-identity you@example.com
# Then accept the verification email AWS sends to that address.
