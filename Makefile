.PHONY: install generate \
	config_runtime_showcase config_management_showcase \
	flags_runtime_showcase flags_management_showcase

install:
	npm ci

generate:
	npm run generate

config_runtime_showcase:
	npx tsx examples/config_runtime_showcase.ts

config_management_showcase:
	npx tsx examples/config_management_showcase.ts

flags_runtime_showcase:
	npx tsx examples/flags_runtime_showcase.ts

flags_management_showcase:
	npx tsx examples/flags_management_showcase.ts
