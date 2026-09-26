/* Shared route classifier. Native code reads the same navigation-rules.json. */
(function (root) {
  "use strict";
  function createPolicy(rules) {
    const hasPrefix = (path, prefix) => path === prefix || path.startsWith(prefix + "/");
    function classify(value, base = rules.inboxURL) {
      let url;
      try { url = new URL(value, base); } catch (_) { return "blocked"; }
      if (url.protocol !== "https:" || url.username || url.password ||
          (url.port && url.port !== "443") || !rules.hosts.includes(url.hostname)) {
        return "blocked";
      }
      // Encoded separators can have different meanings to browser and server.
      // Fail closed instead of interpreting a path more permissively than iOS.
      if (/%(?:2f|5c|00)/i.test(url.pathname)) return "blocked";
      let path;
      try { path = decodeURIComponent(url.pathname); } catch (_) { return "blocked"; }
      if (path.includes("\\") || /[%\u0000-\u0020\u007f]/.test(path)) return "blocked";
      if (rules.messagePrefixes.some(prefix => hasPrefix(path, prefix))) return "messages";
      if (rules.authenticationPrefixes.some(prefix => hasPrefix(path, prefix))) return "authentication";
      return "blocked";
    }
    return Object.freeze({ classify, inboxURL: rules.inboxURL });
  }
  root.InboxOnlyCreatePolicy = createPolicy;
  if (typeof module === "object" && module.exports) module.exports = { createPolicy };
})(typeof globalThis === "object" ? globalThis : this);
