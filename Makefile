# Path: Makefile
.DEFAULT_GOAL := help
SHELL := /bin/sh
COMPOSE ?= docker compose
SERVICES := frontend backend db

.PHONY: help build up down build-up down-up status logs clean annotate-paths $(foreach svc,$(SERVICES),build-$(svc) up-$(svc) down-$(svc) build-up-$(svc) down-up-$(svc))

help:
	@printf 'prompt-helper (all services on network prompt-helper-backend)\n\n'
	@printf '  make build | up | down | build-up | down-up\n'
	@printf '  make build-frontend | up-frontend | down-frontend | build-up-frontend | down-up-frontend\n'
	@printf '  make build-backend  | up-backend  | down-backend  | build-up-backend  | down-up-backend\n'
	@printf '  make build-db       | up-db       | down-db       | build-up-db       | down-up-db\n'
	@printf '  make status | logs | clean | annotate-paths\n'
	@printf '\nFlags: make build NO_CACHE=1; make logs SERVICE=backend\n'
	@printf '       make annotate-paths [DIR=src] [FILES=path/to/file.py,...] [EXTS=py,sql,...]\n'
	@printf '       make annotate-paths [SKIP_DIRS=folder1,folder2] [STARTING_FROM_LAST=1]\n'

build:
	$(COMPOSE) build $(if $(filter 1 true yes,$(NO_CACHE)),--no-cache,)

up:
	$(COMPOSE) up -d --wait

down:
	$(COMPOSE) down

build-up: build up

down-up: down up

# Launch the frontend, starting Compose dependencies when it is not running.
display-frontend: ## Open the frontend in a browser, starting the service when necessary.
	@set -eu; \
	running="$$( $(COMPOSE) ps -q --status running frontend 2>/dev/null || true )"; \
	if [ -z "$$running" ]; then \
		echo 'Starting prompt-helper frontend and dependencies...'; \
		$(COMPOSE) up -d --wait frontend; \
	fi; \
	binding="$$( $(COMPOSE) port frontend 80 )"; \
	if [ -z "$$binding" ]; then \
		echo 'ERROR: frontend has no published host port.' >&2; \
		exit 1; \
	fi; \
	port="$${binding##*:}"; \
	case "$$port" in \
		''|*[!0-9]*) echo "ERROR: invalid published frontend port: $$binding" >&2; exit 1 ;; \
	esac; \
	url="http://127.0.0.1:$$port"; \
	echo "Opening prompt-helper frontend: $$url"; \
	if command -v open >/dev/null 2>&1; then \
		open "$$url"; \
	elif command -v xdg-open >/dev/null 2>&1; then \
		xdg-open "$$url"; \
	elif command -v python3 >/dev/null 2>&1; then \
		python3 -m webbrowser "$$url"; \
	else \
		echo "Open manually: $$url"; \
	fi

status:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f --tail=100 $(SERVICE)

# Removes all revisions/history; deliberately opt-in.
clean:
	@if [ "$(CONFIRM)" != "1" ]; then echo 'Refusing to delete data: use make clean CONFIRM=1' >&2; exit 2; fi
	$(COMPOSE) down --volumes

# Generate full lifecycle for each of the three containers.
define SERVICE_TARGETS
build-$(1):
	$$(COMPOSE) build $$(if $$(filter 1 true yes,$$(NO_CACHE)),--no-cache,) $(1)

up-$(1):
	$$(COMPOSE) up -d --wait $(1)

down-$(1):
	$$(COMPOSE) stop $(1)

build-up-$(1): build-$(1) up-$(1)

down-up-$(1): down-$(1) up-$(1)
endef
$(foreach svc,$(SERVICES),$(eval $(call SERVICE_TARGETS,$(svc))))

# This recipe needs Bash: [[ ]], local, pipefail, ANSI-C quotes, and process substitution.
# Keep the existing /bin/sh default for all other targets.
annotate-paths: SHELL := /bin/bash
annotate-paths:
	@set -euo pipefail; \
	ROOT_DIR="$$(pwd -P)"; \
	DIR_ARG="$${DIR:-}"; \
	FILES_ARG="$${FILES:-}"; \
	if [ -n "$$DIR_ARG" ] && [ -n "$$FILES_ARG" ]; then \
		printf 'ERROR: DIR and FILES are mutually exclusive.\n' >&2; \
		exit 1; \
	fi; \
	if [ -n "$$FILES_ARG" ]; then \
		SCAN_DIR="$$ROOT_DIR"; \
	elif [ -n "$$DIR_ARG" ]; then \
		if [[ "$$DIR_ARG" = /* ]]; then \
			SCAN_DIR="$$(cd "$$DIR_ARG" 2>/dev/null && pwd -P)" || { \
				printf 'ERROR: DIR does not exist or is not accessible: %s\n' "$$DIR_ARG" >&2; \
				exit 1; \
			}; \
		else \
			SCAN_DIR="$$(cd "$$ROOT_DIR/$$DIR_ARG" 2>/dev/null && pwd -P)" || { \
				printf 'ERROR: DIR does not exist or is not accessible: %s\n' "$$DIR_ARG" >&2; \
				exit 1; \
			}; \
		fi; \
	else \
		SCAN_DIR="$$ROOT_DIR"; \
	fi; \
	case "$$SCAN_DIR/" in \
		"$$ROOT_DIR/"*) PATH_BASE="$$ROOT_DIR" ;; \
		*) PATH_BASE="$$SCAN_DIR" ;; \
	esac; \
	STATE_FILE="$${ANNOTATED_PATHS_FILE:-$$PATH_BASE/.annotated-paths}"; \
	EXT_LIST="$${EXTS:-py,sql,ts,tsx,js,swift,sh,mk,makefile}"; \
	SKIP_DIR_LIST="$${SKIP_DIRS:-}"; \
	STARTING_FROM_LAST="$${STARTING_FROM_LAST:-0}"; \
	EXT_LIST="$$(printf '%s' "$$EXT_LIST" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"; \
	SKIP_DIR_LIST="$$(printf '%s' "$$SKIP_DIR_LIST" | tr -d '[:space:]')"; \
	touch "$$STATE_FILE"; \
	UPDATED=0; \
	SKIPPED=0; \
	TOTAL=0; \
	LAST_ANNOTATED=""; \
	RESUME_REACHED=1; \
	if [ "$$STARTING_FROM_LAST" = "1" ]; then \
		LAST_ANNOTATED="$$(tail -n 1 "$$STATE_FILE" 2>/dev/null || true)"; \
		if [ -n "$$LAST_ANNOTATED" ]; then \
			RESUME_REACHED=0; \
			printf 'Resuming after: %s\n' "$$LAST_ANNOTATED"; \
		else \
			printf 'No prior annotation state found; starting from beginning.\n'; \
		fi; \
	fi; \
	is_selected_ext() { \
		local ext="$$1"; \
		case ",$$EXT_LIST," in \
			*,"$$ext",*) return 0 ;; \
			*) return 1 ;; \
		esac; \
	}; \
	is_skipped_path() { \
		local rel="$$1"; \
		local old_ifs="$$IFS"; \
		local skip=""; \
		[ -z "$$SKIP_DIR_LIST" ] && return 1; \
		IFS=','; \
		for skip in $$SKIP_DIR_LIST; do \
			IFS="$$old_ifs"; \
			skip="$${skip#./}"; \
			skip="$${skip%/}"; \
			[ -z "$$skip" ] && { IFS=','; continue; }; \
			if [[ "$$skip" == */* ]]; then \
				case "$$rel" in \
					"$$skip"|"$$skip"/*) \
						IFS="$$old_ifs"; \
						return 0 \
						;; \
				esac; \
			else \
				case "/$$rel/" in \
					*/"$$skip"/*) \
						IFS="$$old_ifs"; \
						return 0 \
						;; \
				esac; \
			fi; \
			IFS=','; \
		done; \
		IFS="$$old_ifs"; \
		return 1; \
	}; \
	record_state() { \
		local rel="$$1"; \
		grep -Fqx -- "$$rel" "$$STATE_FILE" || printf '%s\n' "$$rel" >> "$$STATE_FILE"; \
	}; \
	has_expected_path() { \
		local file="$$1"; \
		local rel="$$2"; \
		local line; \
		while IFS= read -r line || [ -n "$$line" ]; do \
			line="$${line%$$'\r'}"; \
			if [[ "$$line" == *"Path: $$rel" ]]; then \
				return 0; \
			fi; \
		done < "$$file"; \
		return 1; \
	}; \
	prefix_for_ext() { \
		case "$$1" in \
			sql) printf '%s' '--' ;; \
			ts|tsx|js|jsx|mjs|cjs|swift|java|kt|kts|c|cc|cpp|cxx|h|hpp|cs|go|rs) printf '%s' '//' ;; \
			sh|bash|zsh|yaml|yml|toml|ini|cfg|conf|rb|pl|pm|r|mk|makefile) printf '%s' '#' ;; \
			*) return 1 ;; \
		esac; \
	}; \
	annotate_python() { \
		local file="$$1"; \
		local rel="$$2"; \
		local first_stmt=""; \
		local stmt=""; \
		local trimmed=""; \
		local quote=""; \
		first_stmt="$$(grep -n -m 1 -E -v '^[[:space:]]*($$|#)' "$$file" || true)"; \
		if [ -n "$$first_stmt" ]; then \
			stmt="$${first_stmt#*:}"; \
			trimmed="$${stmt#"$${stmt%%[![:space:]]*}"}"; \
		fi; \
		case "$$trimmed" in \
			'"""'*|r'"""'*|R'"""'*|u'"""'*|U'"""'*) quote='"""' ;; \
			"'''"*|r"'''"*|R"'''"*|u"'''"*|U"'''"*) quote="'''" ;; \
		esac; \
		if [ -n "$$quote" ]; then \
			REL="$$rel" QUOTE="$$quote" perl -0pi -e 'my $$q = $$ENV{QUOTE}; my $$r = $$ENV{REL}; s{\A((?:\xEF\xBB\xBF)?(?:(?:[ \t]*\#[^\r\n]*)?\r?\n)*)([rRuU]{0,2})\Q$$q\E(?:\r?\n?[ \t]*Path:[^\r\n]*(?:\r?\n)?)?}{$$1 . $$2 . $$q . "\nPath: " . $$r . "\n"}ex;' "$$file"; \
		else \
			REL="$$rel" perl -0pi -e 'my $$r = $$ENV{REL}; s{\A((?:\xEF\xBB\xBF)?(?:\#\![^\r\n]*\r?\n)?(?:[ \t]*\#.*coding[:=][^\r\n]*\r?\n)?)(?:\# Path:[^\r\n]*(?:\r?\n)?)?}{$$1 . "# Path: " . $$r . "\n"}ex;' "$$file"; \
		fi; \
	}; \
	annotate_prefixed() { \
		local file="$$1"; \
		local rel="$$2"; \
		local prefix="$$3"; \
		local preserve_shebang="$$4"; \
		REL="$$rel" PREFIX="$$prefix" PRESERVE_SHEBANG="$$preserve_shebang" perl -0pi -e 'my $$r = $$ENV{REL}; my $$p = $$ENV{PREFIX}; if ($$ENV{PRESERVE_SHEBANG} eq "1") { s{\A((?:\#\![^\r\n]*\r?\n)?)(?:\Q$$p\E[ \t]+Path:[^\r\n]*(?:\r?\n)?)?}{$$1 . $$p . " Path: " . $$r . "\n"}ex; } else { s{\A(?:\Q$$p\E[ \t]+Path:[^\r\n]*(?:\r?\n)?)?}{$$p . " Path: " . $$r . "\n"}ex; }' "$$file"; \
	}; \
	printf 'Annotating extensions: %s\n' "$$EXT_LIST"; \
	printf 'Make repository root: %s\n' "$$ROOT_DIR"; \
	printf 'Starting directory: %s\n' "$$SCAN_DIR"; \
	printf 'Path base: %s\n' "$$PATH_BASE"; \
	printf 'Annotation state file: %s\n' "$$STATE_FILE"; \
	printf 'STARTING_FROM_LAST=%s\n' "$$STARTING_FROM_LAST"; \
	if [ -n "$$SKIP_DIR_LIST" ]; then \
		printf 'Skipping directories: %s\n' "$$SKIP_DIR_LIST"; \
	fi; \
	while IFS= read -r -d '' FILE; do \
		REL="$${FILE#"$${PATH_BASE}/"}"; \
		if [ -n "$$FILES_ARG" ]; then \
			case ",$$FILES_ARG," in \
				*,"$$REL",*) ;; \
				*) continue ;; \
			esac; \
		fi; \
		if is_skipped_path "$$REL"; then \
			continue; \
		fi; \
		NAME="$${FILE##*/}"; \
		case "$$NAME" in \
			Makefile|makefile) EXT="makefile" ;; \
			*.*) EXT="$${NAME##*.}" ;; \
			*) continue ;; \
		esac; \
		EXT="$$(printf '%s' "$$EXT" | tr '[:upper:]' '[:lower:]')"; \
		is_selected_ext "$$EXT" || continue; \
		if [ "$$STARTING_FROM_LAST" = "1" ] && [ "$$RESUME_REACHED" = "0" ]; then \
			if [ "$$REL" = "$$LAST_ANNOTATED" ]; then \
				RESUME_REACHED=1; \
			fi; \
			continue; \
		fi; \
		TOTAL=$$((TOTAL + 1)); \
		if [ ! -r "$$FILE" ] || [ ! -w "$$FILE" ]; then \
			printf 'SKIP    %s (not readable/writable)\n' "$$REL"; \
			SKIPPED=$$((SKIPPED + 1)); \
			continue; \
		fi; \
		if grep -Fqx -- "$$REL" "$$STATE_FILE"; then \
			if has_expected_path "$$FILE" "$$REL"; then \
				printf 'SKIP    %s (already annotated)\n' "$$REL"; \
				SKIPPED=$$((SKIPPED + 1)); \
				continue; \
			else \
				printf 'STALE   %s (state exists but annotation missing; repairing)\n' "$$REL"; \
			fi; \
		elif has_expected_path "$$FILE" "$$REL"; then \
			record_state "$$REL"; \
			printf 'SKIP    %s (path already present; added to state)\n' "$$REL"; \
			SKIPPED=$$((SKIPPED + 1)); \
			continue; \
		fi; \
		if [ "$$EXT" = "py" ]; then \
			annotate_python "$$FILE" "$$REL"; \
		elif PREFIX="$$(prefix_for_ext "$$EXT")"; then \
			case "$$PREFIX" in \
				'//'|'#') PRESERVE_SHEBANG=1 ;; \
				*) PRESERVE_SHEBANG=0 ;; \
			esac; \
			annotate_prefixed "$$FILE" "$$REL" "$$PREFIX" "$$PRESERVE_SHEBANG"; \
		else \
			printf 'SKIP    %s (unsupported comment syntax for .%s)\n' "$$REL" "$$EXT"; \
			SKIPPED=$$((SKIPPED + 1)); \
			continue; \
		fi; \
		record_state "$$REL"; \
		printf 'UPDATED %s\n' "$$REL"; \
		UPDATED=$$((UPDATED + 1)); \
	done < <( \
		find "$$SCAN_DIR" \
			-type f \
			-not -path '*/.git/*' \
			-not -path '*/node_modules/*' \
			-not -path '*/.venv/*' \
			-not -path '*/venv/*' \
			-not -path '*/__pycache__/*' \
			-not -path '*/.next/*' \
			-not -path '*/build/*' \
			-not -path '*/.build/*' \
			-not -path '*/DerivedData/*' \
			-not -path '*/SourcePackages/*' \
			-not -path '*/Pods/*' \
			-not -path '*/Carthage/*' \
			-not -path '*/vendor/*' \
			-not -path '*/dist/*' \
			-not -path '*/coverage/*' \
			-print0 \
	); \
	if [ "$$STARTING_FROM_LAST" = "1" ] && [ -n "$$LAST_ANNOTATED" ] && [ "$$RESUME_REACHED" = "0" ]; then \
		printf '\nWARNING: last recorded path was not found in the current scan: %s\n' "$$LAST_ANNOTATED"; \
	fi; \
	printf '\nProcessed %s selected files; updated %s; skipped %s.\n' \
		"$$TOTAL" "$$UPDATED" "$$SKIPPED"

include make/concat.mk
