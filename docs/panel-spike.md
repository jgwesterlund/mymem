# Quick-capture panel spike (M0)

**Status: implemented, automated checks green, interactive QA pending (needs a human at the screen).**

## What is implemented
- `src/main/windows/quickCapture.ts`: `BrowserWindow` with `type: 'panel'` (maps to
  `NSWindowStyleMaskNonactivatingPanel`), frameless, `vibrancy: 'hud'`, always-on-top at
  `screen-saver` level, `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`.
- Global hotkey `⌃⌘Space` (registered in `src/main/index.ts`) toggles it; the panel centers on
  the display containing the cursor, hides on blur and on `Esc`, saves on `Enter`
  (`capture:save` — stub until M1).
- Works with the main window closed (`window-all-closed` keeps the app alive).

## Why this is a spike
Electron's panel type has a bug history: #35483, #35815 (non-activating styleMask quirks).
Research said: verify on the current Electron (41.7.2) before depending on it.

## Manual QA checklist (John — run `npm run dev`, then from ANOTHER app):
1. Press ⌃⌘Space while e.g. Safari is focused → panel appears WITHOUT the myMem dock icon
   bouncing/activating, and the textarea has key focus immediately (type a few chars).
2. Safari should still look focused (its traffic lights stay colored).
3. Press Esc → panel hides; focus returns to Safari without flicker.
4. Try on a second Space and over a full-screen app.
5. Press ⌃⌘Space twice quickly → no ghost/duplicate panels.

## Fallback (if QA fails)
Swap `type: 'panel'` for a regular frameless window with `alwaysOnTop: 'screen-saver'` +
`app.dock.hide()`-less focus stealing — accepts that the app activates on capture. One-line
change in `quickCapture.ts`; no other code depends on panel semantics.
