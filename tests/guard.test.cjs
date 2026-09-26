const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const resources = path.join(__dirname, "..", "InboxOnly", "Resources");
const rules = JSON.parse(fs.readFileSync(path.join(resources, "navigation-rules.json"), "utf8"));
const policySource = fs.readFileSync(path.join(resources, "policy.js"), "utf8");
const guardSource = fs.readFileSync(path.join(resources, "guard.js"), "utf8");

const VIEWPORT = { width: 390, height: 700 };

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.isConnected = false;
    this.id = "";
    this.textContent = "";
    this.rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    this.dispatched = [];
    this.muted = false;
    this.paused = false;
  }

  appendChild(child) {
    child.isConnected = true;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
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

  closest(selector) {
    let element = this;
    while (element) {
      if (selector === "a[href]" && element.tagName === "A" && element.hasAttribute("href")) {
        return element;
      }
      element = element.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    if (selector === 'meta[name="viewport"]') {
      return this.children.find(child => child.tagName === "META" && child.getAttribute("name") === "viewport") || null;
    }
    return null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  dispatchEvent(event) {
    this.dispatched.push(event.type);
    return true;
  }

  pause() {
    this.paused = true;
  }
}

class FakeLink extends FakeElement {
  constructor(href, target = "") {
    super("a");
    this.href = href;
    this.target = target;
    this.setAttribute("href", href);
  }
}

class FakeDataTransfer {
  constructor() {
    const files = [];
    this.files = files;
    this.items = { add(file) { files.push(file); } };
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

function coveringRect() {
  return { top: 0, bottom: VIEWPORT.height, left: 0, right: VIEWPORT.width, width: VIEWPORT.width, height: VIEWPORT.height };
}

function createGuardEnvironment({
  initialURL = rules.inboxURL,
  navigationLinks = [],
  native = true,
  historyOnPrototype = false,
} = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const mutationObservers = [];
  const animationFrames = [];
  const intervals = [];
  const nativeMessages = [];
  const replaceCalls = [];
  const assignCalls = [];
  const historyCalls = [];
  const videos = [];
  const fileInputs = [];
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

  const historyMethods = {
    pushState(state, title, url) {
      historyCalls.push({ method: "pushState", state, title, url });
      if (url != null) location.href = url;
    },
    replaceState(state, title, url) {
      historyCalls.push({ method: "replaceState", state, title, url });
      if (url != null) location.href = url;
    },
  };
  let History;
  let history;
  if (historyOnPrototype) {
    History = function History() {};
    Object.assign(History.prototype, historyMethods);
    history = new History();
  } else {
    history = { ...historyMethods };
  }

  const html = new FakeElement("html");
  html.isConnected = true;
  const head = new FakeElement("head");
  const document = {
    documentElement: html,
    head,
    hidden: false,
    createElement(tagName) { return new FakeElement(tagName); },
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    querySelectorAll(selector) {
      if (selector === 'nav a[href], [role="navigation"] a[href]') return navigationLinks;
      if (selector === 'input[type="file"]') return fileInputs;
      return [];
    },
    getElementsByTagName(tagName) {
      return tagName === "video" ? videos : [];
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
    File,
    Event,
    atob,
    DataTransfer: FakeDataTransfer,
    Date: { now: () => now },
    MutationObserver: FakeMutationObserver,
    document,
    history,
    location,
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    setInterval(callback) {
      intervals.push(callback);
      return intervals.length;
    },
    webkit: { messageHandlers: { inboxOnly: { postMessage(message) { nativeMessages.push(message); } } } },
  };
  if (History) sandbox.History = History;
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

  function dispatch(listeners, type, event) {
    if (event && event.type == null) event.type = type;
    for (const listener of listeners.get(type) || []) {
      if (event?.propagationStopped) break;
      listener(event);
    }
    return event;
  }

  return {
    context,
    document,
    head,
    html,
    location,
    history,
    historyCalls,
    nativeMessages,
    replaceCalls,
    assignCalls,
    videos,
    fileInputs,
    createLink: (href, target) => new FakeLink(href, target),
    createElement: (tagName, attributes = {}) => {
      const element = new FakeElement(tagName);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      return element;
    },
    dispatchDocument: (type, event) => dispatch(documentListeners, type, event),
    dispatchWindow: (type, event) => dispatch(windowListeners, type, event),
    flushAnimationFrames() {
      while (animationFrames.length) animationFrames.shift()();
    },
    tick() {
      for (const callback of intervals) callback();
    },
    setURL(value) { location.href = value; },
    setNow(value) { now = value; },
    triggerMutation(records = []) {
      for (const observer of mutationObservers) observer.callback(records);
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

test("a blocked link tap is swallowed with a notice and leaves the chat as it was", () => {
  const env = createGuardEnvironment({ initialURL: "/direct/t/thread-id/" });
  const event = makeEvent(env.createLink("https://www.instagram.com/reel/C0FFEE/", "_blank"));

  env.dispatchDocument("click", event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
  assert.equal(env.location.href, "https://www.instagram.com/direct/t/thread-id/");
  assert.deepEqual(env.nativeMessages, ["notice"]);
  assert.equal(env.html.hasAttribute("data-inbox-only-blocked"), false);
  assert.deepEqual(env.replaceCalls, []);
});

test("allowed direct-thread, authentication, fragment and script links are not intercepted", () => {
  const env = createGuardEnvironment();
  const thread = makeEvent(env.createLink("https://www.instagram.com/direct/t/123_abc/"));
  const login = makeEvent(env.createLink("https://www.instagram.com/accounts/login/?next=%2Freels%2F"));
  const fragment = makeEvent(env.createLink("#"));
  const script = makeEvent(env.createLink("javascript:void(0)"));

  for (const event of [thread, login, fragment, script]) env.dispatchDocument("click", event);

  for (const event of [thread, login, fragment, script]) assert.equal(event.defaultPrevented, false);
  assert.deepEqual(env.nativeMessages, []);
});

test("a refused SPA route reloads the open chat once, and permitted routes still change", () => {
  const env = createGuardEnvironment({ initialURL: "/direct/t/thread-id/" });

  env.context.history.pushState({}, "", "/direct/t/other-thread/");
  assert.equal(env.location.href, "https://www.instagram.com/direct/t/other-thread/");
  env.context.history.replaceState({}, "", "/direct/t/other-thread/?theme=1");
  assert.equal(env.historyCalls.length, 2);
  assert.deepEqual(env.nativeMessages, []);

  env.context.history.pushState({ source: "test" }, "", "/reels/");
  assert.equal(env.location.href, "https://www.instagram.com/direct/t/other-thread/?theme=1");
  assert.equal(env.historyCalls.length, 2);
  assert.deepEqual(env.nativeMessages, ["blocked"]);
  assert.equal(env.html.hasAttribute("data-inbox-only-blocked"), true);
  // The native app reloads the chat; the page does not navigate itself.
  assert.deepEqual(env.replaceCalls, []);

  env.context.history.replaceState({}, "", "/explore/");
  assert.deepEqual(env.nativeMessages, ["blocked"]);
});

test("History.prototype is patched so a router cannot bypass an instance patch", () => {
  const env = createGuardEnvironment({ historyOnPrototype: true, initialURL: "/direct/t/a/" });

  assert.equal(Object.prototype.hasOwnProperty.call(env.history, "pushState"), false);
  env.context.History.prototype.pushState.call(env.history, {}, "", "/p/C0FFEE/");

  assert.deepEqual(env.historyCalls, []);
  assert.deepEqual(env.nativeMessages, ["blocked"]);
});

test("a refused route on the login page goes to the inbox instead of reloading login", () => {
  const env = createGuardEnvironment({ initialURL: "/accounts/login/" });

  env.context.history.pushState({}, "", "/");

  assert.deepEqual(env.nativeMessages, ["blocked"]);
  assert.deepEqual(env.replaceCalls, [rules.inboxURL]);
});

test("popstate redirects a browser-history arrival at a forbidden route", () => {
  const env = createGuardEnvironment();
  env.setURL("https://www.instagram.com/p/C0FFEE/");

  env.dispatchWindow("popstate");

  assert.deepEqual(env.replaceCalls, [rules.inboxURL]);
  assert.equal(env.location.href, rules.inboxURL);
  assert.deepEqual(env.nativeMessages, ["blocked"]);
});

test("the backstop timer catches a URL change that no hook reported", () => {
  const env = createGuardEnvironment({ initialURL: "/direct/t/a/" });
  env.setURL("https://www.instagram.com/stories/someone/");

  env.tick();

  assert.deepEqual(env.nativeMessages, ["blocked"]);
  assert.deepEqual(env.replaceCalls, [rules.inboxURL]);
});

test("window.open reuses the view only for allowed locations and returns no popup", () => {
  const env = createGuardEnvironment();

  assert.equal(env.context.window.open("/direct/t/thread-id/"), null);
  assert.deepEqual(env.assignCalls, ["https://www.instagram.com/direct/t/thread-id/"]);
  assert.equal(env.location.href, "https://www.instagram.com/direct/t/thread-id/");

  env.setNow(2_000);
  assert.equal(env.context.window.open("/reels/"), null);
  assert.deepEqual(env.assignCalls, ["https://www.instagram.com/direct/t/thread-id/"]);
  assert.deepEqual(env.nativeMessages, ["notice"]);
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

test("the page viewport is locked so the message box never zooms the chat", () => {
  const env = createGuardEnvironment();
  const existing = env.createElement("meta", { name: "viewport", content: "width=device-width" });
  env.head.appendChild(existing);

  env.flushAnimationFrames();

  assert.equal(existing.getAttribute("content"), "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no");
  assert.equal(env.head.children.length, 1);
});

test("Safari without a native handler reloads the chat itself on a refused SPA route", () => {
  const env = createGuardEnvironment({ native: false, initialURL: "/direct/t/a/" });
  env.context.history.pushState({}, "", "/reels/");
  assert.deepEqual(env.replaceCalls, ["https://www.instagram.com/direct/t/a/"]);
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
  assert.deepEqual(env.nativeMessages, ["notice"]);
});

test("tapping a non-anchor Reel card is swallowed on release without reloading the chat", () => {
  const env = createGuardEnvironment({ initialURL: "/direct/t/thread-id/" });
  const reelCard = env.createElement("div", { role: "button", "data-href": "/reel/C0FFEE/" });
  const thumbnail = env.createElement("img", { alt: "Shared media" });
  reelCard.appendChild(thumbnail);

  const down = makeEvent(thumbnail, { touches: [{ clientX: 100, clientY: 300 }] });
  env.dispatchWindow("touchstart", down);
  assert.equal(down.propagationStopped, true);
  assert.equal(down.defaultPrevented, false, "a press must never stop the chat scrolling");

  const up = makeEvent(thumbnail, { changedTouches: [{ clientX: 102, clientY: 303 }] });
  env.dispatchWindow("touchend", up);
  assert.equal(up.propagationStopped, true);
  assert.equal(up.defaultPrevented, true);

  assert.deepEqual(env.nativeMessages, ["notice"]);
  assert.equal(env.html.hasAttribute("data-inbox-only-blocked"), false);
});

test("a swipe that starts on a Reel card still scrolls the chat and shows no notice", () => {
  const env = createGuardEnvironment({ initialURL: "/direct/t/thread-id/" });
  const card = env.createElement("button", { "data-reel-id": "17841400000000000" });
  const inner = env.createElement("span");
  card.appendChild(inner);

  const down = makeEvent(inner, { touches: [{ clientX: 100, clientY: 500 }] });
  const pointer = makeEvent(inner, { clientX: 100, clientY: 500 });
  env.dispatchWindow("touchstart", down);
  env.dispatchWindow("pointerdown", pointer);
  const up = makeEvent(inner, { changedTouches: [{ clientX: 104, clientY: 260 }] });
  env.dispatchWindow("touchend", up);

  for (const event of [down, pointer, up]) assert.equal(event.defaultPrevented, false);
  assert.deepEqual(env.nativeMessages, []);
});

test("a bounded accessible Reel or Clip icon inside a clickable card is blocked without an anchor", () => {
  for (const label of ["Reel", "Clip"]) {
    const env = createGuardEnvironment();
    const card = env.createElement("div", { role: "button", "aria-label": "Open shared media" });
    const hitArea = env.createElement("span");
    const icon = env.createElement("svg", { "aria-label": label });
    card.appendChild(hitArea);
    card.appendChild(icon);
    const event = makeEvent(hitArea);

    env.dispatchDocument("click", event);

    assert.equal(event.defaultPrevented, true, label);
    assert.equal(event.propagationStopped, true, label);
    assert.deepEqual(env.nativeMessages, ["notice"], label);
  }
});

test("ordinary photo, video-message, composer, and message-text interactions stay usable", () => {
  const env = createGuardEnvironment();
  const photoCard = env.createElement("div", { role: "button", "data-media-type": "image", "aria-label": "Photo shared by fishing_reel" });
  const photo = env.createElement("img", { alt: "Photo of a fishing reel", title: "fishing reel" });
  photoCard.appendChild(photo);
  const videoCard = env.createElement("div", { role: "button", "aria-label": "Play video message" });
  const video = env.createElement("video");
  videoCard.appendChild(video);
  const composer = env.createElement("textarea", { "aria-label": "Message" });
  const ordinaryTextCard = env.createElement("div", { role: "button" });
  ordinaryTextCard.textContent = "Someone mentioned a Reel in this message.";

  const photoEvent = makeEvent(photo);
  const videoEvent = makeEvent(video);
  const videoUp = makeEvent(video);
  const composerEvent = makeEvent(composer);
  const textEvent = makeEvent(ordinaryTextCard);
  env.dispatchDocument("click", photoEvent);
  env.dispatchDocument("pointerdown", videoEvent);
  env.dispatchDocument("touchend", videoUp);
  env.dispatchDocument("click", composerEvent);
  env.dispatchDocument("click", textEvent);

  for (const event of [photoEvent, videoEvent, videoUp, composerEvent, textEvent]) {
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, false);
  }
  assert.deepEqual(env.nativeMessages, []);
});

test("window capture catches a Reel card first, while Tab does not block a focused card", () => {
  const tabEnv = createGuardEnvironment();
  const tabCard = tabEnv.createElement("div", { role: "button", "data-href": "/reel/C0FFEE/" });
  const tab = makeEvent(tabCard, { key: "Tab" });
  tabEnv.dispatchDocument("keydown", tab);
  assert.equal(tab.defaultPrevented, false);
  assert.deepEqual(tabEnv.nativeMessages, []);

  const env = createGuardEnvironment();
  const card = env.createElement("div", { role: "button", "data-href": "/reel/C0FFEE/" });
  const child = env.createElement("span");
  card.appendChild(child);
  const event = makeEvent(child);
  env.dispatchWindow("click", event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
  assert.deepEqual(env.nativeMessages, ["notice"]);
});

test("a full-screen player over a chat is silenced, hidden and reported without a URL change", () => {
  const env = createGuardEnvironment({ initialURL: "/direct/t/thread-id/" });
  const bubble = env.createElement("video");
  bubble.rect = { top: 180, bottom: 620, left: 20, right: 270, width: 250, height: 440 };
  env.videos.push(bubble);

  env.tick();
  assert.deepEqual(env.nativeMessages, [], "a video bubble inside the chat is not a player");

  const player = env.createElement("video");
  player.rect = coveringRect();
  env.videos.push(player);
  env.dispatchDocument("play", { target: player });

  assert.equal(env.location.href, "https://www.instagram.com/direct/t/thread-id/");
  assert.deepEqual(env.nativeMessages, ["reel"]);
  assert.equal(env.html.hasAttribute("data-inbox-only-blocked"), true);
  for (const video of [bubble, player]) {
    assert.equal(video.muted, true);
    assert.equal(video.paused, true);
  }

  const next = env.createElement("video");
  env.dispatchDocument("playing", { target: next });
  assert.equal(next.paused, true, "a suggested Reel that starts afterwards is paused too");
  env.tick();
  assert.deepEqual(env.nativeMessages, ["reel"], "reported once per page");

  const blockedTap = makeEvent(env.createElement("div"));
  env.dispatchWindow("click", blockedTap);
  assert.equal(blockedTap.defaultPrevented, true, "input is swallowed while the chat reloads");
});

test("a player that grows to full screen without any mutation is caught by the timer", () => {
  const env = createGuardEnvironment({ initialURL: "/direct/t/thread-id/" });
  const player = env.createElement("video");
  env.videos.push(player);
  env.tick();
  assert.deepEqual(env.nativeMessages, []);

  player.rect = { top: 40, bottom: 680, left: 0, right: 390, width: 390, height: 640 };
  env.tick();

  assert.deepEqual(env.nativeMessages, ["reel"]);
});

test("Safari reloads the chat itself when a full-screen player opens", () => {
  const env = createGuardEnvironment({ native: false, initialURL: "/direct/t/thread-id/" });
  const player = env.createElement("video");
  player.rect = coveringRect();
  env.videos.push(player);

  env.tick();

  assert.deepEqual(env.replaceCalls, ["https://www.instagram.com/direct/t/thread-id/"]);
});

test("a newly rendered Reel dialog is hidden and reported even when the URL remains a direct route", () => {
  const env = createGuardEnvironment({ initialURL: "/direct/t/thread-id/" });
  const modal = env.createElement("div", { role: "dialog", "aria-modal": "true" });
  const reelViewer = env.createElement("div", { "data-testid": "reel_viewer" });
  modal.appendChild(reelViewer);
  env.html.appendChild(modal);

  env.triggerMutation([{ type: "childList", target: env.html, addedNodes: [modal] }]);

  assert.equal(env.location.href, "https://www.instagram.com/direct/t/thread-id/");
  assert.equal(env.html.hasAttribute("data-inbox-only-blocked"), true);
  assert.deepEqual(env.nativeMessages, ["reel"]);
});

test("an ordinary photo lightbox mutation is not treated as a Reel modal", () => {
  const env = createGuardEnvironment();
  const modal = env.createElement("div", { role: "dialog", "aria-modal": "true" });
  modal.appendChild(env.createElement("img", { alt: "Photo attachment" }));
  env.html.appendChild(modal);

  env.triggerMutation([{ type: "childList", target: env.html, addedNodes: [modal] }]);

  assert.equal(env.html.hasAttribute("data-inbox-only-blocked"), false);
  assert.deepEqual(env.nativeMessages, []);
});

test("a Reel marker added deep in an existing modal is checked from the mutation target", () => {
  const env = createGuardEnvironment();
  const modal = env.createElement("div", { role: "dialog", "aria-modal": "true" });
  for (let index = 0; index < 22; index += 1) modal.appendChild(env.createElement("div"));
  const marker = env.createElement("svg", { "aria-label": "Open Reel" });
  modal.appendChild(marker);
  env.html.appendChild(modal);

  env.triggerMutation([{ type: "childList", target: modal, addedNodes: [marker] }]);

  assert.equal(env.html.hasAttribute("data-inbox-only-blocked"), true);
  assert.deepEqual(env.nativeMessages, ["reel"]);
});

test("Reel metadata added to an existing dialog child is treated as a modal bypass", () => {
  const env = createGuardEnvironment();
  const modal = env.createElement("div", { role: "dialog", "aria-modal": "true" });
  const viewer = env.createElement("div");
  modal.appendChild(viewer);
  env.html.appendChild(modal);
  viewer.setAttribute("data-reel-id", "17841400000000000");

  env.triggerMutation([{ type: "attributes", target: viewer, addedNodes: [] }]);

  assert.equal(env.html.hasAttribute("data-inbox-only-blocked"), true);
  assert.deepEqual(env.nativeMessages, ["reel"]);
});

test("a native photo is handed to Instagram's own upload control in the open chat", () => {
  const env = createGuardEnvironment({ initialURL: "/direct/t/thread-id/" });
  const audioOnly = env.createElement("input", { type: "file", accept: "audio/*" });
  const upload = env.createElement("input", { type: "file", accept: "audio/*,.mp4,.mov,.png,.jpg,.jpeg" });
  env.fileInputs.push(audioOnly, upload);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");

  assert.equal(env.context.__inboxOnlyAttachPhoto(jpeg), "attached");

  assert.equal(upload.files.length, 1);
  assert.equal(upload.files[0].name, "photo.jpg");
  assert.equal(upload.files[0].type, "image/jpeg");
  assert.equal(upload.files[0].size, 6);
  assert.deepEqual(upload.dispatched, ["input", "change"]);
  assert.equal(audioOnly.files, undefined);
});

test("photo hand-off refuses outside a chat and reports a missing upload control", () => {
  const inbox = createGuardEnvironment();
  inbox.fileInputs.push(inbox.createElement("input", { type: "file" }));
  assert.equal(inbox.context.__inboxOnlyAttachPhoto("AAAA"), "not-in-thread");

  const chat = createGuardEnvironment({ initialURL: "/direct/t/thread-id/" });
  assert.equal(chat.context.__inboxOnlyAttachPhoto("AAAA"), "no-input");
  assert.equal(chat.context.__inboxOnlyAttachPhoto(""), "unsupported");
});
