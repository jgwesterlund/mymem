#!/usr/bin/env swift
// myMem app-icon master: 1024×1024 PNG — rounded plate on a warm terracotta
// gradient with a white lowercase "m" in SF Rounded Heavy, optically centered
// on its glyph bounds. Apple-stock toolchain only (Swift JIT, no Xcode):
//   swift scripts/make-icon.swift [out.png]      (default resources/icon.png)
// scripts/make-icon.sh turns the master into resources/icon.icns.
import AppKit
import CoreText

// ── Design knobs ──────────────────────────────────────────────────────────────
let canvasSize: CGFloat = 1024
let plateInset: CGFloat = 100 // transparent margin around the plate (Apple icon grid)
let cornerRadius: CGFloat = 185 // Apple-grid corner radius at 1024 pt
let gradientTop = (r: 0xE8, g: 0x8D, b: 0x67) // #e88d67 — lifted app accent (#d96c47)
let gradientBottom = (r: 0xBC, g: 0x51, b: 0x28) // #bc5128 — deepened app accent
let glyph = "m"
let glyphFontSize: CGFloat = 600 // SF Rounded Heavy at this size fills the plate nicely
let glyphOpticalYNudge: CGFloat = 0 // + moves the m up; tweak if it reads low/high

func srgb(_ c: (r: Int, g: Int, b: Int)) -> CGColor {
  CGColor(srgbRed: CGFloat(c.r) / 255, green: CGFloat(c.g) / 255, blue: CGFloat(c.b) / 255, alpha: 1)
}

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "resources/icon.png"

let space = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(
  data: nil, width: Int(canvasSize), height: Int(canvasSize), bitsPerComponent: 8,
  bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("could not create CGContext") }

// Rounded plate, clipped, vertical gradient (top = lighter)
let plate = CGRect(
  x: plateInset, y: plateInset,
  width: canvasSize - 2 * plateInset, height: canvasSize - 2 * plateInset
)
ctx.addPath(CGPath(roundedRect: plate, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil))
ctx.clip()
let gradient = CGGradient(
  colorsSpace: space, colors: [srgb(gradientTop), srgb(gradientBottom)] as CFArray, locations: [0, 1]
)!
ctx.drawLinearGradient(
  gradient,
  start: CGPoint(x: canvasSize / 2, y: canvasSize - plateInset),
  end: CGPoint(x: canvasSize / 2, y: plateInset),
  options: []
)

// White "m" in SF Rounded Heavy via CTLine, centered on its glyph IMAGE bounds
// (cap-height/baseline metrics would sit a lowercase glyph visibly low).
let base = NSFont.systemFont(ofSize: glyphFontSize, weight: .heavy)
let rounded = base.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: glyphFontSize) } ?? base
let attributed = NSAttributedString(string: glyph, attributes: [
  .font: rounded,
  kCTForegroundColorAttributeName as NSAttributedString.Key: CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
])
let line = CTLineCreateWithAttributedString(attributed)
let bounds = CTLineGetImageBounds(line, ctx) // relative to the (0,0) text position
ctx.textPosition = CGPoint(
  x: canvasSize / 2 - bounds.midX,
  y: canvasSize / 2 - bounds.midY + glyphOpticalYNudge
)
CTLineDraw(line, ctx)

guard let image = ctx.makeImage() else { fatalError("makeImage failed") }
let rep = NSBitmapImageRep(cgImage: image)
rep.size = NSSize(width: canvasSize, height: canvasSize)
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("PNG encode failed") }
do {
  try png.write(to: URL(fileURLWithPath: outPath))
} catch {
  fatalError("could not write \(outPath): \(error)")
}
print("wrote \(outPath) (\(Int(canvasSize))×\(Int(canvasSize)))")
