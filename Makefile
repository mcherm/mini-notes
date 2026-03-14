# Requires: cargo-lambda (cargo install cargo-lambda), AWS CLI
# https://www.cargo-lambda.info/

LAMBDA_DIR := target/lambda
STAGE      ?= dev
SENTINELS  := target/.sentinels

.PHONY: build build-api-v1 zip zip-api-v1 deploy clean

# ── Build ─────────────────────────────────────────────────────────────────────

build-api-v1:
	cargo lambda build --release --arm64 --lambda-dir $(LAMBDA_DIR) --package api-v1

build: build-api-v1

# ── Package ───────────────────────────────────────────────────────────────────

zip-api-v1: build-api-v1
	zip -j $(LAMBDA_DIR)/api-v1/bootstrap.zip $(LAMBDA_DIR)/api-v1/bootstrap

zip: zip-api-v1

# ── Deploy (update an already-created Lambda function) ────────────────────────

API_V1_SOURCES := $(shell find lambdas/api-v1/src -type f)
HTML_SOURCES   := $(shell find html -type f)

$(SENTINELS)/deploy-api-v1-$(STAGE): $(API_V1_SOURCES)
	$(MAKE) zip-api-v1
	aws lambda update-function-code \
	    --function-name mini-notes-api-v1-$(STAGE) \
	    --zip-file fileb://$(LAMBDA_DIR)/api-v1/bootstrap.zip \
	    --architectures arm64
	@mkdir -p $(SENTINELS)
	@touch $@

$(SENTINELS)/deploy-frontend-$(STAGE): $(HTML_SOURCES)
	aws s3 sync html/ s3://mini-notes-frontend-$(STAGE)/ --delete
	@mkdir -p $(SENTINELS)
	@touch $@

deploy-api-v1: $(SENTINELS)/deploy-api-v1-$(STAGE)
deploy-frontend: $(SENTINELS)/deploy-frontend-$(STAGE)
deploy: deploy-api-v1 deploy-frontend

# ── Misc ──────────────────────────────────────────────────────────────────────

clean:
	cargo clean
	rm -rf $(SENTINELS)
