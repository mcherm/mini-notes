# Password Reset Implementation Plan

Tracking checklist for the password-reset-by-email feature. Each step is a
self-contained unit to be reviewed before moving to the next.

## Decisions (locked)

- **Token in DB**: stored plaintext (token has short lifetime; tokens are
  high-entropy mini-notes ID strings). Format
  `<rfc3339-timestamp>|<reset-token>` where the reset-token uses the
  mini-notes ID alphabet (`0-9A-Za-z_~`).
- **Token generation**: extend `generate_id()` to take a length parameter; existing
  callers pass `ID_LENGTH` (10); reset-token callers pass `32` (~192 bits over the
  64-char alphabet).
- **Separator**: `|`.
- **Session invalidation on reset**: scan-based, factored into a reusable function
  in `handlers/common.rs` and shared with `handle_delete_user`. Includes a TODO
  comment about switching to a `sessions-by-user-id` GSI when scale demands.
- **Email validity**: simple check — non-empty local-part, `@`, non-empty subdomain,
  `.`, non-empty TLD.
- **Send-side rate limit**: refuse new send if existing token is younger than 60s
  (still returns 204).
- **Stateless brute-force defense**: on a wrong-token attempt, 1-in-64 chance to
  clear `password_reset_token`.
- **Password validity**: shared `validate_password` function, currently `len > 0`,
  used by `user_create`, `user_edit`, and `pwd_reset_change`.
- **SES sender**: domain identity `noreply@mini-notes.com` (Route 53 controlled);
  process includes DKIM verification and SES sandbox exit.
- **URL shape**: `{FRONTEND_BASE_URL}/reset-password.html?user_id=…&token=…`.
- **Region**: same as the rest of the app.
- **UI**: shadow-box overlay, consistent with other modals.
- **Email input**: switch `#email-entry` (login form) to `type="email"`.

## Constants to be defined

- `PASSWORD_RESET_TOKEN_MAX_AGE = 3 hours`
- `PASSWORD_RESET_RESEND_COOLDOWN = 60 seconds`
- `PASSWORD_RESET_TOKEN_LENGTH = 32`
- `PASSWORD_RESET_TOKEN_BURN_DENOMINATOR = 32`
- Stored-format separator: literal `|` (no constant)

---

## Phase 1 — Refactors first

- [x] **1.** `generate_id` accepts a length parameter. Update `is_valid_id`
      accordingly. Update all current callers to pass `ID_LENGTH`. Tests pass.
- [x] **2.** Shared `validate_password` function with rule `len > 0`. Apply in
      `handle_user_create` and `handle_edit_user` (when `new_password` is `Some`).
      Add empty-password test cases to both endpoints.
- [x] **3.** Extract session-by-user deletion from `handle_delete_user` into
      `handlers/common.rs` as a reusable function. Add the TODO comment about
      scan scaling.

## Phase 2 — Token helpers, model, infra

- [x] **4.** `User` gains `password_reset_token: Option<String>`. `TryFrom` reads
      via `get_opt_s`. Not exposed in `From<User> for JsonValue`. Add round-trip test.
- [x] **5.** New module `pwd_reset.rs` with the constants listed above and the
      functions: `generate_reset_token`, `format_stored_token`,
      `parse_stored_token`, `email_looks_valid`. Unit tests for each.
- [x] **6.** Add `aws-sdk-sesv2` to `lambdas/common`; expose `ses_client()` next
      to `dynamo_client()`.
- [x] **7.** `AppState` gains `ses_client`, `frontend_base_url`. (The
      from-address is hardcoded in the send handler, not put on
      `AppState`.)
- [x] **8.** SES sending: regular `pwd_reset::send_reset_email(client, from,
      to, link)` async fn that the handler will call directly via
      `state.ses_client`. (Mirrors the DynamoDB testing pattern: tests stub
      at the HTTP layer via `test_ses_client(events)` rather than swapping a
      function pointer. No `SendOps` extractor.) Added
      `test_state_with_ses(dynamo, ses)` helper for tests that need to
      assert SES calls; existing `test_state(dynamo)` continues to work
      with an empty-events SES client.
- [x] **9.** IAM policy update — add `ses:SendEmail`. Update
      `aws/create-iam-role.sh` and provide a one-shot CLI snippet for the
      existing dev role. (Snippet recorded under step 27.)
- [x] **10.** Lambda env vars: remove `ALLOWED_ORIGIN` (now derived in
      code from `STAGE`). The frontend base URL is also derived from
      `STAGE`, and the from-address is hardcoded in the send handler — so
      no new env vars are added. Updated `aws/create-lambda-api-v1.sh`;
      one-shot snippet recorded under step 28.
      **REMINDER (mcherm requested):** the snippet under step 28 also
      removes `ALLOWED_ORIGIN` from the deployed environment, since
      `update-function-configuration` replaces the entire env-var set.
- [x] **11.** Verify SES domain identity for `mini-notes.com`. New
      `aws/configure-ses.sh` script: creates the SES domain identity,
      fetches the DKIM tokens, looks up the Route 53 hosted zone for the
      domain, UPSERTs the three DKIM CNAME records, and prints a one-liner
      to poll verification status. Listed in `aws/README.md`. The actual
      run + waiting for `DkimAttributes.Status == SUCCESS` is part of step 29.
- [x] **12.** Move SES out of sandbox — documented in the bottom block of
      `aws/configure-ses.sh`. Procedure: SES Console → Account dashboard →
      Request production access. Pre-filled use-case description in the
      script comment is ready to copy-paste. The actual submission +
      waiting for approval is part of step 29 (≈24-hour turnaround).
      Also includes a one-liner for verifying a single recipient address
      so the feature can be tested before sandbox-exit lands.

## Phase 3 — Send endpoint

- [x] **13.** `handlers/handle_pwd_reset_send.rs`. Body `PwdResetSendBody`. Always
      returns 204. Email-validity, user-lookup, cooldown, store-token, send-email
      (via `pwd_reset::send_reset_email(&state.ses_client, ...)`; the from-address
      is a `const` in the handler module), log-and-swallow on send failure.
- [x] **14.** Wire route `POST /api/v1/pwd_reset/send` in `main.rs`.
- [x] **15.** Tests: invalid email, no such user, send happens, send
      rate-limited, SES failure swallowed.

## Phase 4 — Complete endpoint

- [x] **16.** `handlers/handle_pwd_reset_change.rs`. Body `PwdResetChangeBody`.
      Validate password; fetch user; check stored token (constant-time
      compare); on mismatch roll the 1-in-32 die; on match conditional-update
      with new password hash and REMOVE `password_reset_token`; invalidate
      sessions; 204. New plumbing: `RandomOps` extractor in `extractors.rs`,
      `random_u32` in `utils.rs`, `constant_time_eq` in `pwd_reset.rs`.
      Also a small `clear_token_conditional` helper used both for
      expired-token cleanup and burn-die wipes.
- [x] **17.** Wire route `POST /api/v1/pwd_reset/change_pwd` in `main.rs`.
- [x] **18.** Tests: success; user not found; no stored token; expired; wrong
      token (deterministic die — both burn-lands and burn-doesn't-land);
      empty password; sessions-cleared check (covered by happy path); also
      added a conditional-update-failure case to verify the 401 vs 500
      mapping when a concurrent send rotates the token mid-request.
- [x] **18a.** Revisit module organization. Chose option (b): dissolved
      `pwd_reset.rs` entirely. `PASSWORD_RESET_TOKEN_MAX_AGE` (used by
      both handlers) → `handlers/common.rs`. `constant_time_eq()` →
      `utils.rs` (generic helper). The `RESEND_COOLDOWN`,
      `TOKEN_LENGTH` constants, plus `email_looks_valid()` and
      `send_reset_email()` (single caller each) → into
      `handle_pwd_reset_send.rs`. `BURN_DENOMINATOR` → into
      `handle_pwd_reset_change.rs`. `generate_reset_token()` was a
      one-line wrapper and got inlined as
      `generate_id_of_length(PASSWORD_RESET_TOKEN_LENGTH)` (the
      constant's name carries the intent).

## Phase 5 — Frontend: forgot-password on login

- [x] **19.** `html/index.html`: change `#email-entry` to `type="email"`; add
      "Forgot password?" link in `<login-form>`; add `<shadow-box
      id="forgot-password-dialog">` with email input, send button, back button,
      and a confirmation text area.
- [x] **20.** `html/main.css`: style the new link and dialog.
- [x] **21.** `html/main.js`: action functions for opening / closing the dialog
      and sending the request. Wire listeners. Email pre-fills from the login
      field on dialog open. Send-button closes the dialog regardless of outcome
      (per the indistinguishable-response design); no inline message shown.

## Phase 6 — Frontend: reset-password landing page

- [x] **22.** `html/reset-password.html`: header + reset form with new-password
      input, submit, error display, hidden user_id / token fields. Loads
      `main.css` and `reset-password.js`. Modeled after admin.html
      (single-purpose landing page; no service-worker registration).
- [x] **23.** `html/reset-password.js`: read URL params, action function that
      POSTs and redirects on success, displays error on failure.
- [x] **24.** Layout CSS for the reset page.

## Phase 7 — Copy & docs

- [x] **25.** Update `#user-account-info` settings copy in `index.html` to
      describe self-serve password reset.
- [x] **26.** Update `docs/design_notes.md` for both endpoints to match
      implemented behavior. Also added `PasswordResetToken` to the data
      structures section.

## Phase 8 — Deploy & verify

- [x] **27.** Apply IAM policy update to dev role. One-shot CLI:
      ```bash
      REGION=$(aws configure get region)
      ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
      aws iam put-role-policy \
          --role-name mini-notes-lambda-role \
          --policy-name ses-send-email-mini-notes \
          --policy-document "{
              \"Version\": \"2012-10-17\",
              \"Statement\": [{
                  \"Effect\": \"Allow\",
                  \"Action\": \"ses:SendEmail\",
                  \"Resource\": \"arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/mini-notes.com\"
              }]
          }"
      ```
      The IAM role is shared across stages, so this only needs to be applied
      once — not separately for prod.
- [x] **28.** Apply Lambda env-var update to dev Lambda. Note that
      `update-function-configuration` REPLACES the entire env-var set; the
      command below removes `ALLOWED_ORIGIN` (no longer read) and adds
      `FROM_EMAIL`. One-shot CLI:
      ```bash
      aws lambda update-function-configuration \
          --function-name "mini-notes-api-v1-${STAGE}" \
          --environment "Variables={STAGE=${STAGE},RUST_LOG=info}"
      ```
      Run once with `STAGE=dev`, then again with `STAGE=prod` (when prod
      deploys in step 33). Source `aws/env.sh` first. The snippet removes
      `ALLOWED_ORIGIN` from the deployed environment (it's no longer read)
      and fixes a pre-existing bug where `RUST_LOG=info` was placed
      outside the `Variables={...}` braces in the original deploy script,
      so it was never actually being set on the live Lambdas.
- [x] **29.** Confirm SES domain identity verified; sandbox-exit status.
      Domain identity created via SES Console with auto-publish to Route 53;
      DKIM verified (Successful) for all three records. Account is already
      out of sandbox in us-east-1 from prior projects (50,000/day quota), so
      no production-access submission needed and no recipient verification
      needed for testing.
- [x] **30.** `make build && make zip && make deploy` (dev).
- [x] **31.** Upload static assets to dev.
- [x] **32.** Manual end-to-end on dev: forgot-password → email → link → set new
      password → land on login → log in with new → other sessions gone → old
      password rejected → token not reusable → expired token rejected.
- [x] **33.** Repeat 27–32 for prod. (IAM and SES are shared and didn't
      need redoing; env-vars, code deploy, static assets, and a subset of
      manual tests were re-run with `STAGE=prod`.)
