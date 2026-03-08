# Requires: cargo-lambda (cargo install cargo-lambda), AWS CLI
# https://www.cargo-lambda.info/

LAMBDA_DIR := target/lambda
STAGE      ?= dev

.PHONY: build build-api-v1 zip zip-api-v1 deploy deploy-api-v1 clean

# ── Build ─────────────────────────────────────────────────────────────────────

build-api-v1:
	cargo lambda build --release --arm64 --lambda-dir $(LAMBDA_DIR) --package api-v1

build: build-api-v1

# ── Package ───────────────────────────────────────────────────────────────────

zip-api-v1: build-api-v1
	zip -j $(LAMBDA_DIR)/api-v1/bootstrap.zip $(LAMBDA_DIR)/api-v1/bootstrap

zip: zip-api-v1

# ── Deploy (update an already-created Lambda function) ────────────────────────

deploy-api-v1: zip-api-v1
	aws lambda update-function-code \
	    --function-name mini-notes-api-v1-$(STAGE) \
	    --zip-file fileb://$(LAMBDA_DIR)/api-v1/bootstrap.zip \
	    --architectures arm64

deploy: deploy-api-v1

# ── Misc ──────────────────────────────────────────────────────────────────────

clean:
	cargo clean
