# Assets

Application artwork. Copyright 2026 Amazon.com, Inc. or its affiliates, licensed
under the Apache License, Version 2.0 with the rest of this project — see
[LICENSE](../LICENSE) and [NOTICE](../NOTICE).

| File | Used for |
| --- | --- |
| `icons/icon.png` | Source master (1024×1024); Linux `deb`/`rpm` package icon |
| `icons/icon.icns` | macOS icon without mask padding |
| `icons/icon.ico` | Windows executable and Squirrel installer icon |
| `icons/icon-mac.icns` | macOS app + DMG volume icon |
| `icons/icon-mac.png` | Source master for the macOS variant |
| `logo.png`, `logo-light.png` | Alternate branding artwork |

The macOS variants carry extra transparent padding so the artwork sits correctly
inside the rounded-rect mask macOS applies; using the unpadded `icon` on macOS
looks oversized next to other Dock icons. `apps/desktop-shell/forge.config.ts`
picks the variant per platform and passes these extensionless to Forge, which
appends the right extension per target.
