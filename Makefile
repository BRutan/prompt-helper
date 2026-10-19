.DEFAULT_GOAL := help
SHELL := /bin/sh
COMPOSE ?= docker compose
SERVICES := frontend backend db

.PHONY: help build up down build-up down-up status logs clean $(foreach svc,$(SERVICES),build-$(svc) up-$(svc) down-$(svc) build-up-$(svc) down-up-$(svc))

help:
	@printf 'Prompterr (all services on network prompterr-backend)\n\n'
	@printf '  make build | up | down | build-up | down-up\n'
	@printf '  make build-frontend | up-frontend | down-frontend | build-up-frontend | down-up-frontend\n'
	@printf '  make build-backend  | up-backend  | down-backend  | build-up-backend  | down-up-backend\n'
	@printf '  make build-db       | up-db       | down-db       | build-up-db       | down-up-db\n'
	@printf '  make status | logs | clean\n'
	@printf '\nFlags: make build NO_CACHE=1; make logs SERVICE=backend\n'

build:
	$(COMPOSE) build $(if $(filter 1 true yes,$(NO_CACHE)),--no-cache,)

up:
	$(COMPOSE) up -d --wait

down:
	$(COMPOSE) down

build-up: build up

down-up: down up

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
