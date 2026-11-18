// Renders the app icon, Android adaptive foreground, splash image and favicon
// in assets/images/ from assets/images/app-mark.svg.
//
// Run `npm run render-icons` from mobile/ after editing the SVG, then commit
// the PNGs. macOS only: AppKit rasterizes the SVG, so no npm package is needed.

import AppKit

/// Icon tile color: `colors.light.accent` in constants/theme.ts. Mirrors the
/// Android `adaptiveIcon.backgroundColor` and splash `backgroundColor` in app.json.
private let tileColor = CGColor(srgbRed: 0x2F / 255, green: 0x5D / 255, blue: 0x4A / 255, alpha: 1)

/// Corner radius of an iOS app icon as a fraction of its width.
private let iosCornerFraction: CGFloat = 0.2237

/// Android masks adaptive icons to as little as a 66 dp circle of the 108 dp
/// canvas (radius 0.611 of the half-width). The sparkle tips reach 0.96 of the
/// half-width, so 0.62 keeps them just inside the mask.
private let adaptiveMarkScale: CGFloat = 0.62

private enum Backdrop {
  case transparent
  /// A full-bleed color. iOS rejects app icons with an alpha channel and
  /// rounds the corners itself, so this renders an opaque PNG.
  case square(CGColor)
  /// A color clipped to a rounded square, with corner radius as a fraction of the width.
  case rounded(CGColor, cornerFraction: CGFloat)
}

private struct Output {
  let file: String
  let size: Int
  let backdrop: Backdrop
  /// Mark width as a fraction of the image width, centered.
  let markScale: CGFloat
}

private let outputs = [
  Output(file: "icon.png", size: 1024, backdrop: .square(tileColor), markScale: 1),
  Output(file: "adaptive-icon.png", size: 1024, backdrop: .transparent, markScale: adaptiveMarkScale),
  Output(file: "splash-icon.png", size: 1024, backdrop: .transparent, markScale: 1),
  Output(
    file: "favicon.png", size: 48,
    backdrop: .rounded(tileColor, cornerFraction: iosCornerFraction), markScale: 1),
]

private let imagesDir = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()
  .deletingLastPathComponent()
  .appendingPathComponent("assets/images")

private func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("render-app-icons: \(message)\n".utf8))
  exit(1)
}

private func render(mark: NSImage, output: Output) {
  let size = CGFloat(output.size)
  let rect = CGRect(x: 0, y: 0, width: size, height: size)
  let alphaInfo: CGImageAlphaInfo
  if case .square = output.backdrop { alphaInfo = .noneSkipLast } else { alphaInfo = .premultipliedLast }
  guard
    let context = CGContext(
      data: nil, width: output.size, height: output.size, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: alphaInfo.rawValue)
  else { fail("could not create a bitmap for \(output.file)") }

  switch output.backdrop {
  case .transparent:
    break
  case .square(let color):
    context.setFillColor(color)
    context.fill(rect)
  case .rounded(let color, let cornerFraction):
    let radius = size * cornerFraction
    context.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil))
    context.clip()
    context.setFillColor(color)
    context.fill(rect)
  }

  NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
  let inset = size * (1 - output.markScale) / 2
  mark.draw(in: rect.insetBy(dx: inset, dy: inset))
  NSGraphicsContext.current = nil

  let url = imagesDir.appendingPathComponent(output.file)
  guard let image = context.makeImage(),
    let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
  else { fail("could not encode \(output.file)") }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { fail("could not write \(url.path)") }
  print("wrote \(url.path) (\(output.size) px)")
}

let markURL = imagesDir.appendingPathComponent("app-mark.svg")
guard let mark = NSImage(contentsOf: markURL) else { fail("cannot read \(markURL.path)") }
for output in outputs {
  render(mark: mark, output: output)
}
