// Convert a simulator recording to a looping GIF with Apple's own frameworks,
// so no ffmpeg or Python imaging library is needed.
// Usage: swift gif.swift <in.mp4> <out.gif> [fps] [width]
import AVFoundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 3 else {
  FileHandle.standardError.write("usage: gif.swift <in.mp4> <out.gif> [fps] [width]\n".data(using: .utf8)!)
  exit(2)
}
let fps = args.count > 3 ? Double(args[3])! : 10
let width = args.count > 4 ? Double(args[4])! : 440

let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
let duration = CMTimeGetSeconds(try await asset.load(.duration))
guard duration > 0 else {
  FileHandle.standardError.write("no video in \(args[1]); was the recording stopped with SIGINT?\n".data(using: .utf8)!)
  exit(1)
}

let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
let tolerance = CMTime(value: 1, timescale: 60)
generator.requestedTimeToleranceBefore = tolerance
generator.requestedTimeToleranceAfter = tolerance
// Height 0 keeps the aspect ratio.
generator.maximumSize = CGSize(width: width, height: 0)

let frameCount = Int(duration * fps)
let out = URL(fileURLWithPath: args[2])
guard let gif = CGImageDestinationCreateWithURL(out as CFURL, UTType.gif.identifier as CFString, frameCount, nil) else {
  FileHandle.standardError.write("cannot write \(args[2])\n".data(using: .utf8)!)
  exit(1)
}
CGImageDestinationSetProperties(gif, [
  kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0],
] as CFDictionary)

var written = 0
for i in 0..<frameCount {
  let time = CMTime(seconds: Double(i) / fps, preferredTimescale: 600)
  guard let (frame, _) = try? await generator.image(at: time) else { continue }
  // Hold the last frame so the result is readable before the loop restarts.
  let delay = i == frameCount - 1 ? 1.5 : 1 / fps
  CGImageDestinationAddImage(gif, frame, [
    kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay],
  ] as CFDictionary)
  written += 1
}
guard CGImageDestinationFinalize(gif) else {
  FileHandle.standardError.write("failed to finish \(args[2])\n".data(using: .utf8)!)
  exit(1)
}
let bytes = (try? FileManager.default.attributesOfItem(atPath: args[2])[.size] as? Int) ?? 0
print("\(args[2]) \(written) frames \(bytes / 1024) KB")
if bytes > 5_000_000 {
  print("over 5 MB: GitHub may not show it inline. Rerun with a lower GIF_FPS or GIF_WIDTH.")
}
