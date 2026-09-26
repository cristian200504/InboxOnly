import Foundation

struct NavigationRules: Decodable {
    let inboxURL: URL
    let hosts: [String]
    let messagePrefixes: [String]
    let authenticationPrefixes: [String]
}

struct NavigationPolicy {
    enum Route { case messages, authentication, blocked }
    let rules: NavigationRules
    let script: String

    init(bundle: Bundle = .main) throws {
        func resource(_ name: String, _ ext: String) throws -> Data {
            guard let url = bundle.url(forResource: name, withExtension: ext) else {
                throw NSError(domain: "InboxOnly", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing app resource: \(name).\(ext)"])
            }
            return try Data(contentsOf: url)
        }
        let data = try resource("navigation-rules", "json")
        rules = try JSONDecoder().decode(NavigationRules.self, from: data)
        let json = String(decoding: data, as: UTF8.self)
        let classifier = String(decoding: try resource("policy", "js"), as: UTF8.self)
        let guardScript = String(decoding: try resource("guard", "js"), as: UTF8.self)
        script = "window.InboxOnlyRules = \(json);\n" + classifier + "\n" + guardScript
    }

    func classify(_ url: URL) -> Route {
        guard url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(), rules.hosts.contains(host),
              url.user == nil, url.password == nil,
              url.port == nil || url.port == 443,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: true) else { return .blocked }
        let encodedPath = components.percentEncodedPath
        guard encodedPath.range(of: "%2f|%5c|%00", options: [.regularExpression, .caseInsensitive]) == nil,
              let path = encodedPath.removingPercentEncoding,
              !path.contains("\\"), !path.contains("%"),
              !path.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }) else { return .blocked }
        // Collapse dot segments just as a browser does before applying the list.
        var segments: [String] = []
        for part in path.split(separator: "/", omittingEmptySubsequences: false).dropFirst() {
            if part == ".." { if !segments.isEmpty { segments.removeLast() } }
            else if part != "." { segments.append(String(part)) }
        }
        let normalizedPath = "/" + segments.joined(separator: "/")
        func matches(_ prefixes: [String]) -> Bool {
            prefixes.contains { normalizedPath == $0 || normalizedPath.hasPrefix($0 + "/") }
        }
        if matches(rules.messagePrefixes) { return .messages }
        if matches(rules.authenticationPrefixes) { return .authentication }
        return .blocked
    }

    // Child frames need broader access for login challenges and media, but
    // must not launch Instagram or load an embedded Reel viewer.
    func blocksEmbeddedNavigation(_ url: URL) -> Bool {
        let browserSchemes = ["https", "http", "about", "blob", "data", "javascript"]
        guard let scheme = url.scheme?.lowercased(), browserSchemes.contains(scheme) else { return true }
        guard let host = url.host?.lowercased(), rules.hosts.contains(host) else { return false }
        let path = url.standardized.path
        return ["/reel", "/reels", "/clips"].contains {
            path == $0 || path.hasPrefix($0 + "/")
        }
    }

}
