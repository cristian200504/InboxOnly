const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const resources = path.join(__dirname, "..", "InboxOnly", "Resources");
const rules = require(path.join(resources, "navigation-rules.json"));
const { createPolicy } = require(path.join(resources, "policy.js"));

const policy = createPolicy(rules);

test("DM and authentication routes remain usable", () => {
  const accepted = [
    ["https://www.instagram.com/direct/inbox/", "messages"],
    ["https://instagram.com/direct/t/123_abc/?source=push", "messages"],
    ["https://WWW.INSTAGRAM.COM:443/direct/new/", "messages"],
    ["/direct/t/abc/", "messages"],
    ["https://www.instagram.com/accounts/login/?next=%2Freels%2F", "authentication"],
    ["https://www.instagram.com/challenge/abc123/", "authentication"],
    ["https://www.instagram.com/checkpoint/abc123/", "authentication"],
    ["https://www.instagram.com/accounts/two_factor_login/", "authentication"],
  ];

  for (const [url, route] of accepted) {
    assert.equal(policy.classify(url), route, url);
  }
});

test("non-DM Instagram destinations are blocked", () => {
  const blocked = [
    "https://www.instagram.com/",
    "https://www.instagram.com/explore/",
    "https://www.instagram.com/reel/C0FFEE/",
    "https://www.instagram.com/reels/",
    "https://www.instagram.com/p/C0FFEE/",
    "https://www.instagram.com/stories/example/",
    "https://www.instagram.com/exampleuser/",
    "https://www.instagram.com/directly/",
  ];

  for (const url of blocked) {
    assert.equal(policy.classify(url), "blocked", url);
  }
});

test("the policy fails closed for schemes, ports, credentials, and spoofed hosts", () => {
  const blocked = [
    "http://www.instagram.com/direct/inbox/",
    "instagram://direct/inbox/",
    "data:text/html,hello",
    "javascript:alert(1)",
    "https://www.instagram.com:444/direct/inbox/",
    "https://person@www.instagram.com/direct/inbox/",
    "https://www.instagram.com.evil.example/direct/inbox/",
    "https://www.instagram.com@evil.example/direct/inbox/",
    "https://evil.example/?next=https%3A%2F%2Fwww.instagram.com%2Fdirect%2Finbox%2F",
  ];

  for (const url of blocked) {
    assert.equal(policy.classify(url), "blocked", url);
  }
});

test("encoded separators, nulls, malformed escapes, and traversal cannot reach messages", () => {
  const blocked = [
    "https://www.instagram.com/direct/%2fexplore/",
    "https://www.instagram.com/direct/%2Freels/",
    "https://www.instagram.com/direct/%5Creels/",
    "https://www.instagram.com/direct/%00reels/",
    "https://www.instagram.com/direct/%ZZ",
    "https://www.instagram.com/direct/../reels/",
    "https://www.instagram.com/direct/%2e%2e/reels/",
    "https://www.instagram.com/direct/%252f..%252freels/",
    "https://www.instagram.com/direct/%252e%252e/reels/",
    "https://www.instagram.com/direct/%0areels/",
    "https://www.instagram.com/direct/%20/",
  ];

  for (const url of blocked) {
    assert.equal(policy.classify(url), "blocked", url);
  }
});

test("an encoded current-directory segment still resolves to a real direct thread", () => {
  assert.equal(
    policy.classify("https://www.instagram.com/direct/%2E/t/thread-id/"),
    "messages"
  );
});
