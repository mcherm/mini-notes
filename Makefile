# Requires: cargo-lambda (cargo install cargo-lambda), AWS CLI
# https://www.cargo-lambda.info/

LAMBDAS    := api-v1 job-heartbeat
LAMBDA_DIR := target/lambda
STAGE      ?= dev
SENTINELS  := target/.sentinels

.PHONY: build zip deploy deploy-lambdas deploy-frontend test clean \
        $(addprefix build-,$(LAMBDAS)) \
        $(addprefix zip-,$(LAMBDAS)) \
        $(addprefix deploy-,$(LAMBDAS))

# ── Per-lambda rule generator ────────────────────────────────────────────────
# For each lambda L in $(LAMBDAS), generate: build-L, zip-L, deploy-L,
# and the sentinel file rule that tracks source changes for deploy.

COMMON_SOURCES := $(shell find lambdas/common/src -type f) lambdas/common/Cargo.toml

define LAMBDA_RULES
build-$(1):
	cargo lambda build --release --arm64 --lambda-dir $$(LAMBDA_DIR) --package $(1)

zip-$(1): build-$(1)
	zip -j $$(LAMBDA_DIR)/$(1)/bootstrap.zip $$(LAMBDA_DIR)/$(1)/bootstrap

$(1)_SOURCES := $$(shell find lambdas/$(1)/src -type f) lambdas/$(1)/Cargo.toml

$$(SENTINELS)/deploy-$(1)-$$(STAGE): $$($(1)_SOURCES) $$(COMMON_SOURCES)
	$$(MAKE) zip-$(1)
	aws lambda update-function-code \
	    --function-name mini-notes-$(1)-$$(STAGE) \
	    --zip-file fileb://$$(LAMBDA_DIR)/$(1)/bootstrap.zip \
	    --architectures arm64
	@mkdir -p $$(SENTINELS)
	@touch $$@

deploy-$(1): $$(SENTINELS)/deploy-$(1)-$$(STAGE) ;
endef

$(foreach lambda,$(LAMBDAS),$(eval $(call LAMBDA_RULES,$(lambda))))

# ── Aggregate targets ────────────────────────────────────────────────────────

build: $(addprefix build-,$(LAMBDAS))
zip:   $(addprefix zip-,$(LAMBDAS))
deploy-lambdas: $(addprefix deploy-,$(LAMBDAS))

# ── Frontend deploy ──────────────────────────────────────────────────────────

HTML_SOURCES := $(shell find html -type f)

CF_DIST_ID_dev  := EE5QH6UGUBU5G
CF_DIST_ID_prod := ELFIR4781UMJC
CF_DIST_ID      := $(CF_DIST_ID_$(STAGE))

$(SENTINELS)/deploy-frontend-$(STAGE): $(HTML_SOURCES)
	aws s3 sync html/ s3://mini-notes-frontend-$(STAGE)/ --delete
	aws cloudfront create-invalidation \
	    --distribution-id $(CF_DIST_ID) \
	    --paths "/*"
	@mkdir -p $(SENTINELS)
	@touch $@

deploy-frontend: $(SENTINELS)/deploy-frontend-$(STAGE)
deploy: deploy-lambdas deploy-frontend

# ── Test ─────────────────────────────────────────────────────────────────────

test:
	cargo test

# ── Misc ──────────────────────────────────────────────────────────────────────

clean:
	cargo clean
	rm -rf $(SENTINELS)
