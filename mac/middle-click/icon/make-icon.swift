import Cocoa
// Draws icon/icon-1024.png: a blue rounded square with a white mouse. Run: swift icon/make-icon.swift
let size = 1024.0
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let inset = 100.0, r = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
let shape = NSBezierPath(roundedRect: r, xRadius: 185, yRadius: 185)
let shadow = NSShadow(); shadow.shadowBlurRadius = 28; shadow.shadowOffset = NSSize(width: 0, height: -12)
shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
NSGraphicsContext.saveGraphicsState(); shadow.set()
NSColor(srgbRed: 0.16, green: 0.42, blue: 0.98, alpha: 1).setFill(); shape.fill()
NSGraphicsContext.restoreGraphicsState()
NSGradient(starting: NSColor(srgbRed: 0.33, green: 0.62, blue: 1, alpha: 1), ending: NSColor(srgbRed: 0.10, green: 0.30, blue: 0.90, alpha: 1))!
  .draw(in: shape, angle: -90)
let cfg = NSImage.SymbolConfiguration(pointSize: 470, weight: .regular).applying(.init(paletteColors: [.white]))
let mouse = NSImage(systemSymbolName: "computermouse.fill", accessibilityDescription: nil)!.withSymbolConfiguration(cfg)!
let ms = mouse.size
mouse.draw(in: NSRect(x: (size - ms.width) / 2, y: (size - ms.height) / 2, width: ms.width, height: ms.height))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon/icon-1024.png"))
