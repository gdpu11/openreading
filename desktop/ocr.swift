import Foundation
import Vision
import ImageIO

struct Box: Codable {
    let x: Double, y: Double, width: Double, height: Double
    init(_ rect: CGRect) { x = rect.minX; y = rect.minY; width = rect.width; height = rect.height }
    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}
struct Line: Codable {
    var text: String
    var confidence: Float
    var alternatives: [String]
    let box: Box
    var uncertain = false
    var retried = false
}
struct Result: Codable {
    let engine: String
    let lines: [Line]
    let secondaryText: String
}
func normalize(_ text: String) -> String { text.precomposedStringWithCompatibilityMapping.filter { !$0.isWhitespace } }
func recognize(_ url: URL, correction: Bool, region: CGRect? = nil, languages: [String] = ["zh-Hans", "en-US"]) throws -> [Line] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = languages
    request.usesLanguageCorrection = correction
    request.minimumTextHeight = 0
    if let region = region { request.regionOfInterest = region }
    try VNImageRequestHandler(url: url, options: [:]).perform([request])
    return (request.results ?? []).compactMap { observation in
        let candidates = observation.topCandidates(3)
        guard let best = candidates.first else { return nil }
        return Line(text: best.string, confidence: best.confidence, alternatives: candidates.dropFirst().map { $0.string }, box: Box(observation.boundingBox))
    }
}
func overlap(_ a: CGRect, _ b: CGRect) -> Double {
    let height = a.intersection(b).height
    return height.isFinite ? max(0, height) / max(0.001, min(a.height, b.height)) : 0
}
func accurate(_ url: URL) throws -> Result {
    let first = try recognize(url, correction: true)
    let second = try recognize(url, correction: false)
    var retries = 0
    let lines = try first.map { original -> Line in
        var line = original
        let alternate = second.max { overlap(original.box.rect, $0.box.rect) < overlap(original.box.rect, $1.box.rect) }
        let matched = alternate.flatMap { overlap(original.box.rect, $0.box.rect) > 0.5 ? $0 : nil }
        let agrees = matched.map { normalize($0.text) == normalize(original.text) } ?? false
        if agrees && original.confidence >= 0.93 { return line }
        line.uncertain = true
        guard retries < 20 else { return line }
        retries += 1; line.retried = true
        let roi = original.box.rect.insetBy(dx: -0.006, dy: -min(0.004, original.box.height * 0.2)).intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        let latin = original.text.filter { $0.isASCII && $0.isLetter }.count
        let languages = latin > original.text.count / 2 ? ["en-US"] : ["zh-Hans", "en-US"]
        let regionLines = try recognize(url, correction: true, region: roi, languages: languages)
        guard let retry = regionLines.max(by: { $0.text.count < $1.text.count }), retry.text.count >= max(1, original.text.count / 2) else { return line }
        let candidates = [original] + (matched.map { [$0] } ?? []) + [retry]
        let groups = Dictionary(grouping: candidates, by: { normalize($0.text) })
        var winner = groups[normalize(original.text)]!
        var score = winner.reduce(Float(0)) { $0 + $1.confidence }
        for group in groups.values {
            let candidateScore = group.reduce(Float(0)) { $0 + $1.confidence }
            if candidateScore > score + 0.08 { winner = group; score = candidateScore }
        }
        let best = winner.max(by: { $0.confidence < $1.confidence })!
        line.text = best.text; line.confidence = best.confidence
        line.alternatives = Array(Set(candidates.map { $0.text } + original.alternatives)).filter { normalize($0) != normalize(best.text) }.sorted()
        line.uncertain = winner.count < 2 || best.confidence < 0.9
        return line
    }
    return Result(engine: "apple-vision", lines: lines, secondaryText: second.map { $0.text }.joined(separator: "\n"))
}
do {
    let details = CommandLine.arguments.count == 3 && CommandLine.arguments[2] == "--details"
    guard CommandLine.arguments.count == 2 || details else { throw NSError(domain: "OpenReadingOCR", code: 1) }
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    if details {
        FileHandle.standardOutput.write(try JSONEncoder().encode(accurate(url)))
    } else {
        print(try recognize(url, correction: true).map { $0.text }.joined(separator: "\n"))
    }
} catch {
    FileHandle.standardError.write(Data("OCR failed: \(error.localizedDescription)\n".utf8)); exit(1)
}
