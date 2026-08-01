# weirsmith — one entry point for the test suite and the browser UI.
#
# Every target wraps an npm script; those stay the source of truth, because CI
# runs them directly. `make` on its own lists what is available.
#
# Dependencies install themselves: any target that needs node_modules depends on
# it, so `make test` works in a fresh clone.

NPM ?= npm
PORT ?= 8080
DIALECT ?= all
FORMAT ?= all

.DEFAULT_GOAL := help
.PHONY: help install test watch build verify check web build-web probe export clean

help: ## Show this list
	@echo "weirsmith — make <target>"
	@echo
	@grep -hE '^[a-z][a-z-]*:.*## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*## "}; {printf "  \033[1m%-12s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Variables: PORT=$(PORT)  DIALECT=$(DIALECT)  FORMAT=$(FORMAT)  NPM=$(NPM)"

# Real dependency, not .PHONY: it reinstalls only when the manifests change.
# npm leaves node_modules' mtime older than package.json, hence the touch.
node_modules: package.json package-lock.json
	$(NPM) install
	@touch node_modules

install: node_modules ## Install dependencies

test: node_modules ## Run all 173 tests (the pack suites boot a real Harper)
	$(NPM) test

watch: node_modules ## Re-run the fast unit tests on every save
	node --test --watch test/core.test.js test/affix.test.js test/merge.test.js

build: node_modules ## Build the fixture pack -> dist/example.weirpack
	$(NPM) run build

verify: build ## Load that pack into Harper and check every word lints clean
	$(NPM) run verify

check: test verify ## Everything CI runs: tests, then a real build and verify

web: node_modules ## Serve the UI, the sources page and the measurement harness
	@echo "  UI          http://localhost:$(PORT)/"
	@echo "  sources     http://localhost:$(PORT)/src/web/sources.html"
	@echo "  measure     http://localhost:$(PORT)/src/web/measure.html"
	@PORT=$(PORT) $(NPM) run web

build-web: node_modules ## Build a self-contained dist/web for static hosting
	$(NPM) run build:web

probe: node_modules ## Probe a dictionary: make probe FILE=path/to.dic
	@test -n "$(FILE)" || { \
		echo "usage: make probe FILE=<dictionary> [DIALECT=american|all]"; \
		echo "   eg: make probe FILE=node_modules/dictionary-en/index.dic"; \
		exit 1; \
	}
	node src/cli.js probe $(FILE) --dialect $(DIALECT)

export: node_modules ## Export a pack for other spell checkers: make export DIR=mypack
	@test -n "$(DIR)" || { \
		echo "usage: make export DIR=<pack dir or .weirpack> [FORMAT=hunspell,word]"; \
		exit 1; \
	}
	node src/cli.js export $(DIR) --format $(FORMAT) --out dist

clean: ## Remove build output (dist/ is gitignored; nothing else is touched)
	rm -rf dist
