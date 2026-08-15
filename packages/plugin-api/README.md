# `@pizza-bot/plugin-api`

Public, browser-safe schemas and types for Pizza Bot plugin manifests. This
package has no Node, LangChain, runtime, or UI dependency.

The workspace package remains private until its npm publication surface and
release process are defined; "public" describes the supported plugin-facing API
boundary.

`apiVersion` selects the manifest contract. `version` identifies a release of
the plugin itself. `engines.pizzaBot` constrains compatible host releases, while
`capabilities.required` names host features that must exist before activation.
Unknown optional capabilities do not prevent a plugin from loading.

Filesystem discovery, materialization, MCP process management, and contribution
loading remain in `@pizza-bot/plugin-sdk`.
