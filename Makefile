.PHONY: install build generate \
	config_runtime_showcase config_management_showcase \
	flags_runtime_showcase flags_management_showcase \
	logging_runtime_showcase logging_management_showcase

install:
	npm ci

build: install
	npm run build

generate:
	npm run generate

config_runtime_showcase: build
	npx tsx examples/config_runtime_showcase.ts

config_management_showcase: build
	npx tsx examples/config_management_showcase.ts

flags_runtime_showcase: build
	npx tsx examples/flags_runtime_showcase.ts

flags_management_showcase: build
	npx tsx examples/flags_management_showcase.ts

logging_runtime_showcase: build
	npx tsx examples/logging_runtime_showcase.ts

logging_management_showcase: build
	npx tsx examples/logging_management_showcase.ts
