#!/usr/bin/env swift
// myMem app-icon master: 1024×1024 PNG — rounded plate on a cool fjord-blue
// gradient with a white lowercase "m" in SF Rounded Heavy, optically centered
// on its glyph bounds. Apple-stock toolchain only (Swift JIT, no Xcode):
//   swift scripts/make-icon.swift [out.png]            (default resources/icon.png)
//   swift scripts/make-icon.swift --tray <out.png> <size>
// Tray mode renders ONLY the "m" glyph in pure black on transparent at <size> px
// — a macOS template image (the *Template.png naming makes the menu bar tint it
// for light/dark automatically). scripts/make-icon.sh drives both modes.
import AppKit
import CoreText

// ── Design knobs ──────────────────────────────────────────────────────────────
let canvasSize: CGFloat = 1024
let plateInset: CGFloat = 100 // transparent margin around the plate (Apple icon grid)
let cornerRadius: CGFloat = 185 // Apple-grid corner radius at 1024 pt
let gradientTop = (r: 0x6E, g: 0x8F, b: 0xAC) // #6e8fac — lifted fjord accent (#5b7c99)
let gradientBottom = (r: 0x46, g: 0x63, b: 0x7F) // #46637f — deepened fjord accent
let glyph = "m"
let glyphFontSize: CGFloat = 600 // SF Rounded Heavy at this size fills the plate nicely
let glyphOpticalYNudge: CGFloat = 0 // + moves the m up; tweak if it reads low/high

func srgb(_ c: (r: Int, g: Int, b: Int)) -> CGColor {
  CGColor(srgbRed: CGFloat(c.r) / 255, green: CGFloat(c.g) / 255, blue: CGFloat(c.b) / 255, alpha: 1)
}

func makeContext(_ size: CGFloat) -> CGContext {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  guard let ctx = CGContext(
    data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8,
    bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { fatalError("could not create CGContext") }
  return ctx
}

/// White-or-black "m" in SF Rounded Heavy via CTLine, centered on its glyph
/// IMAGE bounds (cap-height/baseline metrics would sit a lowercase glyph visibly low).
func drawGlyph(in ctx: CGContext, canvas: CGFloat, fontSize: CGFloat, color: CGColor, yNudge: CGFloat) {
  let base = NSFont.systemFont(ofSize: fontSize, weight: .heavy)
  let rounded = base.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: fontSize) } ?? base
  let attributed = NSAttributedString(string: glyph, attributes: [
    .font: rounded,
    kCTForegroundColorAttributeName as NSAttributedString.Key: color
  ])
  let line = CTLineCreateWithAttributedString(attributed)
  let bounds = CTLineGetImageBounds(line, ctx) // relative to the (0,0) text position
  ctx.textPosition = CGPoint(
    x: canvas / 2 - bounds.midX,
    y: canvas / 2 - bounds.midY + yNudge
  )
  CTLineDraw(line, ctx)
}

func writePng(_ ctx: CGContext, size: CGFloat, to outPath: String) {
  guard let image = ctx.makeImage() else { fatalError("makeImage failed") }
  let rep = NSBitmapImageRep(cgImage: image)
  rep.size = NSSize(width: size, height: size)
  guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("PNG encode failed") }
  do {
    try png.write(to: URL(fileURLWithPath: outPath))
  } catch {
    fatalError("could not write \(outPath): \(error)")
  }
  print("wrote \(outPath) (\(Int(size))×\(Int(size)))")
}

let args = CommandLine.arguments

if args.count > 1 && args[1] == "--tray" {
  // ── Tray template: bare black "m" on transparent, no plate ────────────────
  guard args.count == 4, let size = Int(args[3]), size > 0 else {
    fatalError("usage: swift scripts/make-icon.swift --tray <out.png> <size>")
  }
  let canvas = CGFloat(size)
  let ctx = makeContext(canvas)
  // Measure-then-fit: "m" is wider than tall, so size the font from its actual
  // image bounds — glyph width fills ~88% of the canvas (menu bar glyphs sit in
  // an 18 pt slot with a hairline of breathing room).
  let black = CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
  let trialSize = canvas
  let base = NSFont.systemFont(ofSize: trialSize, weight: .heavy)
  let rounded = base.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: trialSize) } ?? base
  let trial = CTLineCreateWithAttributedString(NSAttributedString(string: glyph, attributes: [
    .font: rounded,
    kCTForegroundColorAttributeName as NSAttributedString.Key: black
  ]))
  let trialBounds = CTLineGetImageBounds(trial, ctx)
  let fitted = trialSize * (canvas * 0.88) / max(trialBounds.width, 1)
  drawGlyph(in: ctx, canvas: canvas, fontSize: fitted, color: black, yNudge: 0)
  writePng(ctx, size: canvas, to: args[2])
} else {
  // ── App icon master: rounded plate, fjord gradient, white "m" ─────────────
  let outPath = args.count > 1 ? args[1] : "resources/icon.png"
  let ctx = makeContext(canvasSize)

  // Rounded plate, clipped, vertical gradient (top = lighter)
  let plate = CGRect(
    x: plateInset, y: plateInset,
    width: canvasSize - 2 * plateInset, height: canvasSize - 2 * plateInset
  )
  ctx.addPath(CGPath(roundedRect: plate, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil))
  ctx.clip()
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let gradient = CGGradient(
    colorsSpace: space, colors: [srgb(gradientTop), srgb(gradientBottom)] as CFArray, locations: [0, 1]
  )!
  ctx.drawLinearGradient(
    gradient,
    start: CGPoint(x: canvasSize / 2, y: canvasSize - plateInset),
    end: CGPoint(x: canvasSize / 2, y: plateInset),
    options: []
  )

  drawGlyph(
    in: ctx, canvas: canvasSize, fontSize: glyphFontSize,
    color: CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1), yNudge: glyphOpticalYNudge
  )
  writePng(ctx, size: canvasSize, to: outPath)
}
