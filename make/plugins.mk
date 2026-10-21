# Path: make/plugins.mk
# Loaded by the root Makefile's make/*.mk include.

.PHONY: build-chrome-plugin
# @make-param build-chrome-plugin OUTPUT Optional; output directory, default dist/chrome.
build-chrome-plugin: ## Package the Chrome MV3 extension as an unpacked folder and ZIP.
	@python3 plugins/chrome_live.py build $(if $(strip $(OUTPUT)),--output "$(OUTPUT)",)

.PHONY: install-chrome-plugin
# @make-param install-chrome-plugin OUTPUT Optional; same output root as build-chrome-plugin.
# @make-param install-chrome-plugin DRY_RUN Optional; set to 1 to build but skip Chrome UI automation.
install-chrome-plugin: ## Build and update the extension in ordinary Google Chrome (first install needs browser approval).
	@python3 plugins/chrome_live.py install $(if $(strip $(OUTPUT)),--output "$(OUTPUT)",) $(if $(filter 1 true yes,$(DRY_RUN)),--dry-run,)
