# @pizza-bot/inference-providers

The built-in `ModelProvider` adapters and `registerBuiltinProviders`, which the
api-server calls at startup. [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#model-provider-adapters)
covers the seam.

## Adding a model provider

An OpenAI-compatible gateway or proxy is an `OpenAiCompatibleSpec` run by the
shared `OpenAiCompatibleProvider`; see `src/providers/uberllm.ts` for the
smallest one. Anything else implements `ModelProvider` directly.

A provider pull request touches four files:

1. `src/providers/<id>.ts` with the spec or adapter. Its `label` is the name the
   settings page, model picker, and status bar show.
2. `src/providers/<id>.test.ts` covering model listing and anything the provider
   reads differently from the shared defaults.
3. `src/loader.ts`: register it in `registerBuiltinProviders`.
4. The root [README](../../README.md#model-providers): add it to the list, plus
   a sentence if it needs setup beyond an API key.
