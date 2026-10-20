# Path: make/plugins.mk
# Loaded by the root Makefile's make/*.mk include.

.PHONY: build-chrome-plugin
# @make-param build-chrome-plugin OUTPUT Optional; output directory, default dist/chrome.
build-chrome-plugin: ## Package the Chrome MV3 extension as an unpacked folder and ZIP.
	@python3 plugins/build_chrome.py $(if $(strip $(OUTPUT)),--output "$(OUTPUT)",)
