# Build resources

electron-builder's `buildResources` directory (see `electron-builder.yml`).

- `icon.icns` — app icon. Not checked in yet: until one exists, electron-builder
  falls back to the stock Electron icon. Drop a 1024×1024 `icon.png` here (or a
  ready `icon.icns`) and electron-builder picks it up automatically on the next
  `npm run dist`.
- Entitlements plists would also live here once the app is signed/notarized
  (see the `mac:` section comments in `electron-builder.yml`).
