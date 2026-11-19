// Draws the Remote Screen app's icon (icon/remote-screen-1024.png): PS's pink, a screen with a pointer, drawn with plain
// shapes (no symbol font). Run once when it should change:  swift tools/remote-screen-app/make-icon.swift icon/remote-screen-1024.png
// Nothing is shown on screen: it draws into an image in memory and writes the PNG.
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "remote-screen-1024.png"
let S: CGFloat = 1024
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(S), pixelsHigh: Int(S), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let pink = NSColor(red: 0.93, green: 0.31, blue: 0.53, alpha: 1), deep = NSColor(red: 0.55, green: 0.12, blue: 0.36, alpha: 1)
// The macOS icon grid: an 824 px rounded square in the middle of 1024.
let tile = NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824), xRadius: 185, yRadius: 185)
NSGradient(starting: pink, ending: deep)!.draw(in: tile, angle: -90)
// The screen: a dark panel with a white bezel, on a short stand.
let screen = NSRect(x: 232, y: 366, width: 560, height: 380)
NSColor.white.setFill(); NSBezierPath(roundedRect: screen, xRadius: 46, yRadius: 46).fill()
NSColor(white: 0.10, alpha: 1).setFill(); NSBezierPath(roundedRect: screen.insetBy(dx: 26, dy: 26), xRadius: 24, yRadius: 24).fill()
NSColor.white.setFill()
NSBezierPath(roundedRect: NSRect(x: 472, y: 296, width: 80, height: 76), xRadius: 10, yRadius: 10).fill()
NSBezierPath(roundedRect: NSRect(x: 382, y: 262, width: 260, height: 44), xRadius: 22, yRadius: 22).fill()
// A pointer on the screen (the classic arrow, pink with a white edge).
let p = NSBezierPath()
let o = NSPoint(x: 470, y: 650)
for (dx, dy) in [(0.0, 0.0), (0.0, -190.0), (46.0, -146.0), (78.0, -214.0), (110.0, -200.0), (80.0, -134.0), (140.0, -134.0)] { let q = NSPoint(x: o.x + dx, y: o.y + dy); if p.isEmpty { p.move(to: q) } else { p.line(to: q) } }
p.close()
p.lineWidth = 18; p.lineJoinStyle = .round
NSColor.white.setStroke(); p.stroke()
pink.setFill(); p.fill()
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
