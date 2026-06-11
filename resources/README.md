# Build resources

electron-builder's `buildResources` directory (see `electron-builder.yml`).

- `icon.png` (1024² master) + `icon.icns` — the app icon, GENERATED — do not
  hand-edit. Regenerate with `npm run icon` (`scripts/make-icon.sh`: Swift JIT
  draws the master via `scripts/make-icon.swift`, then sips + iconutil build
  the icns — all Apple-stock, no Xcode). Design knobs (gradient, glyph, plate
  inset/radius) are named constants at the top of the Swift file.
  electron-builder picks `icon.icns` up automatically on `npm run dist`
  (DMG volume icon included); dev runs set the dock icon from `icon.png`
  (`src/main/index.ts`).
- Entitlements plists would also live here once the app is signed/notarized
  (see the `mac:` section comments in `electron-builder.yml`).
