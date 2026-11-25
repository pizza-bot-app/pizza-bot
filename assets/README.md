# Assets

Application artwork. Copyright 2026 Amazon.com, Inc. or its affiliates, licensed
under the Apache License, Version 2.0 with the rest of this project — see
[LICENSE](../LICENSE) and [NOTICE](../NOTICE).

| File | Used for |
| --- | --- |
| `icons/illustration.png` | Full illustration (1024×1024); source for every icon below; README header |
| `icons/icon.png` | App icon (the head, 1024×1024); Linux `deb`/`rpm` package icon; Linux window icon |
| `icons/icon.icns` | macOS icon without mask padding |
| `icons/icon.ico` | Windows executable and Squirrel installer icon (16–256px) |
| `icons/icon-mac.icns` | macOS app + DMG volume icon |
| `icons/icon-mac.png` | Source for the macOS variant (padded for the rounded-rect mask) |
| `logo.png`, `logo-light.png` | Alternate branding artwork |

The macOS variants carry extra transparent padding so the artwork sits correctly
inside the rounded-rect mask macOS applies; using the unpadded `icon` on macOS
looks oversized next to other Dock icons. `apps/desktop-shell/forge.config.ts`
picks the variant per platform and passes these extensionless to Forge, which
appends the right extension per target.

Every icon is the robot's head alone, which stays readable down to 16px where
the full illustration turns to mush. It is cut out of `icons/illustration.png` with an
antialiased elliptical mask (centre 524,336, radii 262,205), which also drops the
pizzas and the antenna. Background pixels inside the ellipse are flattened to the
same colour as outside it, so the illustration's lighter vignette doesn't leave an oval
halo: flood-fill the background from the illustration's corners (pixels within a sum of
70 of the corner colour). Crop a 546px square centred on 524,336, then:

- `icons/icon.png`: scale to 1024;
- `icons/icon-mac.png`: scale to 800 and place at 112,112 on a 1024 canvas, keeping
  the existing rounded-rect alpha;
- `icons/icon.icns` and `icons/icon-mac.icns`: `iconutil` iconsets (16–512pt, 1x/2x)
  from those two;
- `icons/icon.ico`, `apps/web/public/favicon.ico` (16/32/48) and
  `apps/web/public/apple-touch-icon.png` (180): scale down from the 546px crop.

The web files live in `apps/web/public/` because Vite copies that directory into
the built app.
