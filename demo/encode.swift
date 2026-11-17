// Encoder for the demo recordings: screencast frames + a camera path → H.264 MP4 and PNG stills.
//
//   swift demo/encode.swift <timeline.json>
//
// timeline.json (written by demo/lib/recorder.mjs):
//   frames      [{ file, t }]          screencast frames and when they arrived (ms from the start)
//   camera      [{ t, d, x, y, w }]    from t, over d ms, the camera eases to this rect (CSS px; height follows 16:9)
//   viewport    { width, height }      CSS px of the captured page
//   durationMs, fps, width, height, bitrate, out
//   stills      [{ t, file }]          PNG stills of the finished picture
//   stillWidth  width of the stills
//   loopFadeMs  over its last loopFadeMs the video fades back to its first picture, so a looping GIF never jumps
//
// Screencast frames arrive only when the page repaints, so each output frame shows the newest frame at or
// before its time. The camera is a crop of the 2x frames, so a zoom stays sharp and the page is never touched.
// No ffmpeg here: AVFoundation ships with macOS.
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO

struct Frame: Decodable { let file: String; let t: Double }
struct Shot: Decodable { let t: Double; let d: Double; let x: Double; let y: Double; let w: Double }
struct Size: Decodable { let width: Double; let height: Double }
struct Still: Decodable { let t: Double; let file: String }
struct Timeline: Decodable {
  let frames: [Frame]; let camera: [Shot]; let viewport: Size
  let durationMs: Double; let out: String
  let width: Int; let height: Int; let fps: Int; let bitrate: Int
  let stills: [Still]; let stillWidth: Int
  let loopFadeMs: Double?
}

let args = CommandLine.arguments
guard args.count > 1 else { fatalError("usage: encode.swift <timeline.json>") }
let timelineURL = URL(fileURLWithPath: args[1])
let dir = timelineURL.deletingLastPathComponent()
let tl = try JSONDecoder().decode(Timeline.self, from: Data(contentsOf: timelineURL))
let W = tl.width, H = tl.height
guard !tl.frames.isEmpty else { fatalError("no frames") }

func ease(_ p: Double) -> Double { p < 0.5 ? 4 * p * p * p : 1 - pow(-2 * p + 2, 3) / 2 }

/// The camera's rect at `t`: the latest move that started, eased from where the camera was.
func camera(at t: Double) -> (x: Double, y: Double, w: Double) {
  var current = (x: 0.0, y: 0.0, w: tl.viewport.width)
  for shot in tl.camera {
    if shot.t > t { break }
    let from = current
    let p = shot.d <= 0 ? 1 : min(1, (t - shot.t) / shot.d)
    let e = ease(p)
    current = (x: from.x + (shot.x - from.x) * e, y: from.y + (shot.y - from.y) * e, w: from.w + (shot.w - from.w) * e)
    if p < 1 { return current }
  }
  return current
}

/// One picture: the frame cropped to the camera at `t`, filling the context.
func draw(_ frame: CGImage, at t: Double, into ctx: CGContext, width: Int, height: Int, alpha: Double = 1) {
  ctx.interpolationQuality = .high
  ctx.setAlpha(alpha)
  defer { ctx.setAlpha(1) }
  let cam = camera(at: t)
  let px = Double(frame.width) / tl.viewport.width
  let cx = cam.x * px, cy = cam.y * px, cw = cam.w * px
  let k = Double(width) / cw
  let iw = Double(frame.width), ih = Double(frame.height)
  if alpha >= 1 {
    ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
  }
  ctx.draw(frame, in: CGRect(x: -cx * k, y: Double(height) - (ih - cy) * k, width: iw * k, height: ih * k))
}

func frameAt(_ t: Double) -> Int {
  var newest = 0
  while newest + 1 < tl.frames.count && tl.frames[newest + 1].t <= t { newest += 1 }
  return newest
}

var cache: [Int: CGImage] = [:]
func image(_ index: Int) -> CGImage? {
  if let hit = cache[index] { return hit }
  let url = dir.appendingPathComponent(tl.frames[index].file) as CFURL
  guard let source = CGImageSourceCreateWithURL(url, nil), let img = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
  if cache.count > 8 { cache.removeAll() }
  cache[index] = img
  return img
}

func makeContext(_ w: Int, _ h: Int) -> CGContext {
  CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
}

// Stills: the same picture as the video's at their times.
for still in tl.stills {
  guard let frame = image(frameAt(still.t)) else { continue }
  let sw = tl.stillWidth, sh = tl.stillWidth * H / W
  let ctx = makeContext(sw, sh)
  draw(frame, at: still.t, into: ctx, width: sw, height: sh)
  let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: still.file) as CFURL, "public.png" as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
  CGImageDestinationFinalize(dest)
}

let outURL = URL(fileURLWithPath: tl.out)
try? FileManager.default.removeItem(at: outURL)
let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
writer.shouldOptimizeForNetworkUse = true
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: W, AVVideoHeightKey: H,
  AVVideoCompressionPropertiesKey: [
    AVVideoAverageBitRateKey: tl.bitrate,
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    AVVideoMaxKeyFrameIntervalKey: tl.fps * 2,
  ],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
  kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H,
])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

let total = Int((tl.durationMs / 1000.0 * Double(tl.fps)).rounded(.up))
let fade = tl.loopFadeMs ?? 0
let first = image(0)
let done = DispatchSemaphore(value: 0)
var index = 0
input.requestMediaDataWhenReady(on: DispatchQueue(label: "video")) {
  while input.isReadyForMoreMediaData {
    if index >= total {
      input.markAsFinished()
      done.signal()
      return
    }
    let t = Double(index) * 1000.0 / Double(tl.fps)
    var buffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
    guard let pixels = buffer, let frame = image(frameAt(t)) else { fatalError("no buffer or frame") }
    CVPixelBufferLockBaseAddress(pixels, [])
    let ctx = CGContext(
      data: CVPixelBufferGetBaseAddress(pixels), width: W, height: H, bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(pixels), space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    )!
    draw(frame, at: t, into: ctx, width: W, height: H)
    if fade > 0, let start = first, t >= tl.durationMs - fade {
      let p = min(1, (t - (tl.durationMs - fade)) / max(1, fade - 1000.0 / Double(tl.fps)))
      draw(start, at: 0, into: ctx, width: W, height: H, alpha: ease(p))
    }
    CVPixelBufferUnlockBaseAddress(pixels, [])
    adaptor.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: CMTimeScale(tl.fps)))
    index += 1
  }
}
done.wait()
let closed = DispatchSemaphore(value: 0)
writer.endSession(atSourceTime: CMTime(value: CMTimeValue(total), timescale: CMTimeScale(tl.fps)))
writer.finishWriting { closed.signal() }
closed.wait()
if writer.status != .completed { fatalError("writer: \(String(describing: writer.error))") }
print("wrote \(tl.out) (\(total) frames, \(tl.stills.count) stills)")
