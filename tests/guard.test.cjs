const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const resources = path.join(__dirname, "..", "InboxOnly", "Resources");
const rules = JSON.parse(fs.readFileSync(path.join(resources, "navigation-rules.json"), "utf8"));
const policySource = fs.readFileSync(path.join(resources, "policy.js"), "utf8");
const guardSource = fs.readFileSync(path.join(resources, "guard.js"), "utf8");

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.isConnected = false;
    this.id = "";
    this.textContent = "";
  }

  appendChild(child) {
    child.isConnected = true;
    this.children.push(child);
    return child;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }
}

class FakeLink extends FakeElement {
  constructor(href, target = "") {
    super("a");
    this.href = href;
    this.target = target;
  }

  closest(selector) {
    return selector === "a[href]" ? this : null;
  }
}

function makeEvent(target, extra = {}) {
  return {
    target,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.propagationStopped = true; },
    ...extra,
  };
}

function createGuardEnvironment({
  initialURL = rules.inboxURL,
  navigationLinks = [],
  native = true,
} = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const mutationObservers = [];
  const animationFrames = [];
  const nativeMessages = [];
  const replaceCalls = [];
  const assignCalls = [];
  const historyCalls = [];
  let now = 1_000;

  const location = {
    _href: new URL(initialURL, rules.inboxURL).href,
    get href() { return this._href; },
    set href(value) { this._href = new URL(value, this._href).href; },
    replace(value) {
      const next = new URL(value, this._href).href;
      replaceCalls.push(next);
      this._href = next;
    },
    assign(value) {
      const next = new URL(value, this._href).href;
      assignCalls.push(next);
      this._href = next;
    },
  };

  const history = {
    pushState(state, title, url) {
      historyCalls.push({ method: "pushState", state, title, url });
      if (url != null) location.href = url;
    },
    replaceState(state, title, url) {
      historyCalls.push({ method: "replaceState", state, title, url });
      if (url != null) location.href = url;
    },
  };

  const html = new FakeElement("html");
  html.isConnected = true;
  const document = {
    documentElement: html,
    hidden: false,
    createElement(tagName) { return new FakeElement(tagName); },
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    querySelectorAll(selector) {
      if (selector === 'nav a[href], [role="navigation"] a[href]') return navigationLinks;
      return [];
    },
  };

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      mutationObservers.push(this);
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
    }
  }

  const sandbox = {
    URL,
    Date: { now: () => now },
    MutationObserver: FakeMutationObserver,
    document,
    history,
    location,
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    webkit: { messageHandlers: { inboxOnly: { postMessage(message) { nativeMessages.push(message); } } } },
  };
  sandbox.window = sandbox;
  if (!native) delete sandbox.webkit;
  sandbox.top = sandbox;
  sandbox.addEventListener = (type, listener) => {
    const listeners = windowListeners.get(type) || [];
    listeners.push(listener);
    windowListeners.set(type, listeners);
  };
  sandbox.InboxOnlyRules = rules;

  const context = vm.createContext(sandbox);
  vm.runInContext(policySource, context, { filename: "policy.js" });
  vm.runInContext(guardSource, context, { filename: "guard.js" });

  function dispatchDocument(type, event) {
    for (const listener of documentListeners.get(type) || []) listener(event);
    return event;
  }

  function dispatchWindow(type) {
    for (const listener of windowListeners.get(type) || []) listener();
  }

  function flushAnimationFrames() {
    while (animationFrames.length) animationFrames.shift()();
  }

  return {
    context,
    document,
    html,
    location,
    historyCalls,
    nativeMessages,
    replaceCalls,
    assignCalls,
    createLink: (href, target) => new FakeLink(href, target),
    dispatchDocument,
    dispatchWindow,
    flushAnimationFrames,
    setURL(value) { location.href = value; },
    setNow(value) { now = value; },
    triggerMutation() {
      for (const observer of mutationObservers) observer.callback([]);
    },
  };
}

test("an initial forbidden route is hidden, reported generically, and replaced with the inbox", () => {
  const env = createGuardEnvironment({ initialURL: "https://www.instagram.com/reels/" });

  assert.deepEqual(env.nativeMessages, ["blocked"]);
  assert.deepEqual(env.replaceCalls, [rules.inboxURL]);
  assert.equal(env.location.href, rules.inboxURL);
  assert.equal(env.html.hasAttribute("data-inbox-only-blocked"), true);
});

test("a blocked capture click, including target=_blank, never reaches the page", () => {
  const env = createGuardEnvironment();
  const event = makeEvent(env.createLink("https://www.instagram.com/reel/C0FFEE/", "_blank"));

  env.dispatchDocument("click", event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
  assert.equal(env.location.href, rules.inboxURL);
  assert.deepEqual(env.nativeMessages, ["blocked"]);
});

test("allowed direct-thread and authentication links are not intercepted", () => {
  const env = createGuardEnvironment();
  const thread = makeEvent(env.createLink("https://www.instagram.com/direct/t/123_abc/"));
  const login = makeEvent(env.createLink("https://www.instagram.com/accounts/login/?next=%2Freels%2F"));

  env.dispatchDocument("click", thread);
  env.dispatchDocument("click", login);

  assert.equal(thread.defaultPrevented, false);
  assert.equal(login.defaultPrevented, false);
  assert.deepEqual(env.nativeMessages, []);
});

test("SPA pushState and replaceState keep the current permitted route on a blocked attempt", () => {
  const env = createGuardEnvironment();

  env.context.history.pushState({ source: "test" }, "", "/reels/");
  assert.equal(env.location.href, rules.inboxURL);
  assert.deepEqual(env.historyCalls, []);
  assert.deepEqual(env.nativeMessages, ["blocked"]);

  env.setNow(2_000);
  env.context.history.pushState({}, "", "/direct/t/thread-id/");
  assert.equal(env.location.href, "https://www.instagram.com/direct/t/thread-id/");
  assert.equal(env.historyCalls.at(-1).method, "pushState");

  env.context.history.replaceState({}, "", "/accounts/login/?next=%2Freels%2F");
  assert.equal(env.location.href, "https://www.instagram.com/accounts/login/?next=%2Freels%2F");
  assert.equal(env.historyCalls.at(-1).method, "replaceState");

  env.context.history.replaceState({}, "", "/explore/");
  assert.equal(env.location.href, "https://www.instagram.com/accounts/login/?next=%2Freels%2F");
  assert.equal(env.historyCalls.filter(call => call.method === "replaceState").length, 1);
  assert.deepEqual(env.nativeMessages, ["blocked", "blocked"]);
});

test("popstate redirects a browser-history arrival at a forbidden route", () => {
  const env = createGuardEnvironment();
  env.setURL("https://www.instagram.com/p/C0FFEE/");

  env.dispatchWindow("popstate");

  assert.deepEqual(env.replaceCalls, [rules.inboxURL]);
  assert.equal(env.location.href, rules.inboxURL);
  assert.deepEqual(env.nativeMessages, ["blocked"]);
});

test("window.open reuses the view only for allowed locations and returns no popup", () => {
  const env = createGuardEnvironment();

  assert.equal(env.context.window.open("/direct/t/thread-id/"), null);
  assert.deepEqual(env.assignCalls, ["https://www.instagram.com/direct/t/thread-id/"]);
  assert.equal(env.location.href, "https://www.instagram.com/direct/t/thread-id/");

  env.setNow(2_000);
  assert.equal(env.context.window.open("/reels/"), null);
  assert.deepEqual(env.assignCalls, ["https://www.instagram.com/direct/t/thread-id/"]);
  assert.deepEqual(env.nativeMessages, ["blocked"]);
});

test("navigation-link refresh and mutation handling keep working without exposing blocked links", () => {
  const blockedLink = new FakeLink("https://www.instagram.com/reels/");
  const allowedLink = new FakeLink("https://www.instagram.com/direct/t/thread-id/");
  const env = createGuardEnvironment({ navigationLinks: [blockedLink, allowedLink] });

  assert.doesNotThrow(() => env.flushAnimationFrames());
  assert.equal(blockedLink.hasAttribute("data-inbox-only-hidden"), true);
  assert.equal(allowedLink.hasAttribute("data-inbox-only-hidden"), false);
  assert.equal(env.document.documentElement.children[0].tagName, "STYLE");

  assert.doesNotThrow(() => {
    env.triggerMutation();
    env.flushAnimationFrames();
  });
  assert.equal(blockedLink.hasAttribute("data-inbox-only-hidden"), true);
});

test("Safari without a native handler reloads the inbox on a blocked SPA attempt", () => {
  const env = createGuardEnvironment({ native: false, initialURL: "/direct/t/a/" });
  env.context.history.pushState({}, "", "/reels/");
  assert.deepEqual(env.replaceCalls, [rules.inboxURL]);
  assert.deepEqual(env.historyCalls, []);
  assert.deepEqual(env.nativeMessages, []);
  assert.equal(env.context.__inboxOnlyGuard, true);
});

test("form submissions allow login but stop external or feed destinations", () => {
  const env = createGuardEnvironment();
  const login = makeEvent({ action: "https://www.instagram.com/accounts/login/" });
  env.dispatchDocument("submit", login);
  assert.equal(login.defaultPrevented, false);
  const external = makeEvent({ action: "https://www.instagram.com/accounts/login/" }, {
    submitter: { formAction: "https://example.com/" }
  });
  env.dispatchDocument("submit", external);
  assert.equal(external.defaultPrevented, true);
  assert.equal(external.propagationStopped, true);
});
