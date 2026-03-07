# Requires: cargo-lambda (cargo install cargo-lambda), AWS CLI
# https://www.cargo-lambda.info/

LAMBDA_DIR := target/lambda
STAGE      ?= dev

.PHONY: build build-get-note zip zip-get-note deploy deploy-get-note clean

# ── Build ─────────────────────────────────────────────────────────────────────

build-get-note:
	cargo lambda build --release --arm64 --lambda-dir $(LAMBDA_DIR) --package get-note

build: build-get-note

# ── Package ───────────────────────────────────────────────────────────────────

zip-get-note: build-get-note
	zip -j $(LAMBDA_DIR)/get-note/bootstrap.zip $(LAMBDA_DIR)/get-note/bootstrap

zip: zip-get-note

# ── Deploy (update an already-created Lambda function) ────────────────────────

deploy-get-note: zip-get-note
	aws lambda update-function-code \
	    --function-name mini-notes-get-note-$(STAGE) \
	    --zip-file fileb://$(LAMBDA_DIR)/get-note/bootstrap.zip \
	    --architectures arm64

deploy: deploy-get-note

# ── Misc ──────────────────────────────────────────────────────────────────────

clean:
	cargo clean
