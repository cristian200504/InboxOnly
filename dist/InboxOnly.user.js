// ==UserScript==
// @name         InboxOnly - Instagram messages
// @namespace    inboxonly.local
// @version      1.1.0
// @description  Keep Instagram messages; block feed, Reels, Explore and profiles, including Reels opened from a chat.
// @match        https://www.instagram.com/*
// @match        https://instagram.com/*
// @run-at       document-start
// @inject-into  auto
// @grant        none
// ==/UserScript==

(function () {
window.InboxOnlyRules = {"inboxURL":"https://www.instagram.com/direct/inbox/","hosts":["www.instagram.com","instagram.com"],"messagePrefixes":["/direct"],"authenticationPrefixes":["/accounts/login","/accounts/logout","/accounts/onetap","/accounts/two_factor_login","/accounts/password/reset","/accounts/password/change","/challenge","/checkpoint","/consent","/privacy/consent","/terms/accept"]};
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

/* Runs at document start in the page world. No credentials/message scraping. */
(function () {
  "use strict";
  if (window.top !== window || window.__inboxOnlyGuard) return;
  const policy = window.InboxOnlyCreatePolicy(window.InboxOnlyRules);
  let recovering = false;
  let pendingRefresh = false;
  let lastNotice = 0;
  let lastHref = location.href;
  let pressStart = null;

  // No pinch zoom, and no automatic zoom when the message box is focused.
  const VIEWPORT = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no";
  const TAP_SLOP = 10;
  const style = document.createElement("style");
  style.id = "inbox-only-style";
  style.textContent = `
    html[data-inbox-only-blocked] { visibility: hidden !important; }
    [data-inbox-only-hidden] { display: none !important; }
    html { -webkit-text-size-adjust: 100% !important; }
    * { -webkit-tap-highlight-color: transparent !important; }
    a, img, svg, video { -webkit-touch-callout: none !important; }
    nav, header, button, svg, img { -webkit-user-select: none !important; user-select: none !important; }
    a[href="/"], a[href="https://www.instagram.com/"], a[href="/explore/"], a[href="/reels/"],
    a[href^="instagram://"] { display: none !important; }
    a[href*="/reel/"], a[href*="/reels/"] { filter: grayscale(1) !important; opacity: .45 !important; }
  `;

  function nativeHandler() {
    return window.webkit?.messageHandlers?.inboxOnly || null;
  }

  // Only fixed event names reach Swift: never URLs, passwords or chat content.
  //   notice  a tap was swallowed and nothing on the page changed
  //   blocked the page reached, or began rendering, a forbidden route
  //   reel    a full-screen video player opened over a conversation
  function post(event) {
    const handler = nativeHandler();
    if (!handler) return false;
    try { handler.postMessage(event); } catch (_) {}
    return true;
  }

  function notice() {
    if (Date.now() - lastNotice < 800) return;
    lastNotice = Date.now();
    post("notice");
  }

  function hidePage() {
    attachStyle();
    const html = document.documentElement;
    if (html && !html.hasAttribute("data-inbox-only-blocked")) html.setAttribute("data-inbox-only-blocked", "");
  }

  function showPage() {
    const html = document.documentElement;
    if (html && html.hasAttribute("data-inbox-only-blocked")) html.removeAttribute("data-inbox-only-blocked");
  }

  // Something forbidden got far enough to render. Hide and silence it, then
  // reload: the native app reopens the same chat (or the inbox), and Safari
  // reloads the page itself. Once per page; the reload resets this state.
  function recover(event) {
    if (recovering) return;
    recovering = true;
    hidePage();
    silenceVideos();
    const native = post(event);
    if (policy.classify(location.href) !== "messages") location.replace(policy.inboxURL);
    else if (!native) location.replace(location.href);
  }

  function attachStyle() {
    if (!style.isConnected && document.documentElement) document.documentElement.appendChild(style);
  }

  function lockViewport() {
    const head = document.head;
    if (!head || typeof head.querySelector !== "function") return;
    let meta = head.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "viewport");
      head.appendChild(meta);
    }
    if (meta.getAttribute("content") !== VIEWPORT) meta.setAttribute("content", VIEWPORT);
  }

  // Reel previews in a DM are sometimes div/button cards rather than anchors.
  // Keep this deliberately narrow: only inspect the tapped card and a small,
  // bounded set of its descendants. Never search message text or the chat body.
  const MAX_CARD_ANCESTORS = 8;
  const MAX_CARD_DESCENDANTS = 20;
  const REEL_URL_ATTRIBUTES = ["href", "data-href", "data-url", "data-link"];
  const REEL_ACCESSIBILITY_ATTRIBUTES = ["aria-label", "title", "alt"];
  const REEL_STRUCTURAL_ATTRIBUTES = [
    "data-testid", "data-reel", "data-reel-id", "data-media-type", "data-media-kind", "data-type"
  ];

  function asElement(node) {
    if (!node) return null;
    if (node.nodeType === 1 || typeof node.getAttribute === "function") return node;
    return node.parentElement || null;
  }

  function attribute(element, name) {
    try { return element?.getAttribute?.(name); } catch (_) { return null; }
  }

  function isReelURL(value) {
    if (!value) return false;
    try {
      const url = new URL(value, location.href);
      if (url.protocol === "instagram:") return /^(?:reel|reels)$/i.test(url.hostname);
      if (url.protocol !== "https:" || !window.InboxOnlyRules.hosts.includes(url.hostname)) return false;
      const path = decodeURIComponent(url.pathname);
      return /(?:^|\/)(?:reels?|clips)(?:\/|$)/i.test(path);
    } catch (_) { return false; }
  }

  function isReelUIAffordance(value) {
    // User-authored alt text/title can mention a fishing reel. Only accept
    // short, explicit UI labels such as "Reel", "Clip", "Open Reel" or "Reel by …".
    const label = String(value || "").trim().toLowerCase()
      .replace(/[,:.!]/g, " ").replace(/\s+/g, " ");
    return /^(?:(?:open|play|view|watch|share|send|replay|close)\s+)?(?:(?:an?|the)\s+)?(?:instagram\s+)?(?:reels?|clips?)(?:\s+(?:video|viewer|preview|icon))?(?:\s+(?:by|from|de\s+la)\s+[^\n]{1,80})?$/.test(label);
  }

  function hasOwnReelSignal(element) {
    if (!element) return false;
    for (const name of REEL_URL_ATTRIBUTES) {
      if (isReelURL(attribute(element, name))) return true;
    }
    for (const name of REEL_ACCESSIBILITY_ATTRIBUTES) {
      const value = attribute(element, name);
      if (value && isReelUIAffordance(value)) return true;
    }
    for (const name of REEL_STRUCTURAL_ATTRIBUTES) {
      const value = attribute(element, name);
      if ((name === "data-reel" || name === "data-reel-id") && value != null) return true;
      if (value && /(?:^|[-_:/])(?:reels?|clips?)(?:$|[-_:/])/i.test(value)) return true;
    }
    return false;
  }

  function isInteractive(element) {
    const tag = element?.tagName?.toUpperCase?.();
    const role = attribute(element, "role");
    return tag === "A" || tag === "BUTTON" || role === "button" || role === "link" ||
      attribute(element, "tabindex") != null;
  }

  function childrenOf(element) {
    const children = element?.children;
    if (!children) return [];
    const result = [];
    for (let index = 0; index < children.length && result.length < MAX_CARD_DESCENDANTS; index++) {
      if (children[index]) result.push(children[index]);
    }
    return result;
  }

  function cardHasReelSignal(card) {
    if (hasOwnReelSignal(card)) return true;
    const pending = childrenOf(card);
    let inspected = 0;
    while (pending.length && inspected < MAX_CARD_DESCENDANTS) {
      const element = pending.shift();
      inspected += 1;
      if (hasOwnReelSignal(element)) return true;
      for (const child of childrenOf(element)) {
        if (pending.length + inspected < MAX_CARD_DESCENDANTS) pending.push(child);
      }
    }
    return false;
  }

  function reelPreviewCard(target) {
    let element = asElement(target);
    for (let depth = 0; element && depth < MAX_CARD_ANCESTORS; depth += 1) {
      if (hasOwnReelSignal(element)) return element;
      if (isInteractive(element)) return cardHasReelSignal(element) ? element : null;
      element = element.parentElement;
    }
    return null;
  }

  function isModal(element) {
    return attribute(element, "role") === "dialog" || attribute(element, "aria-modal") === "true";
  }

  function closestModal(node) {
    let element = asElement(node);
    for (let depth = 0; element && depth < MAX_CARD_ANCESTORS; depth += 1) {
      if (isModal(element)) return element;
      element = element.parentElement;
    }
    return null;
  }

  function boundedModalDescendant(root) {
    const pending = childrenOf(root);
    let inspected = 0;
    while (pending.length && inspected < MAX_CARD_DESCENDANTS) {
      const element = pending.shift();
      inspected += 1;
      if (isModal(element)) return element;
      for (const child of childrenOf(element)) {
        if (pending.length + inspected < MAX_CARD_DESCENDANTS) pending.push(child);
      }
    }
    return null;
  }

  // A link to a forbidden page, or a recognisable Reel card.
  function isForbiddenTarget(target) {
    const element = asElement(target);
    if (!element) return false;
    const link = typeof element.closest === "function" ? element.closest("a[href]") : null;
    const href = link ? attribute(link, "href") : null;
    if (href && !/^\s*(?:#|javascript:)/i.test(href) &&
        policy.classify(href, location.href) === "blocked") return true;
    return Boolean(reelPreviewCard(element));
  }

  function swallow(event) {
    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
  }

  function pointOf(event, ending) {
    const touch = ending ? event?.changedTouches?.[0] : event?.touches?.[0];
    const source = touch || event;
    return typeof source?.clientX === "number" ? { x: source.clientX, y: source.clientY } : null;
  }

  function isTap(event) {
    const end = pointOf(event, true);
    if (!pressStart || !end) return true;
    return Math.abs(end.x - pressStart.x) <= TAP_SLOP && Math.abs(end.y - pressStart.y) <= TAP_SLOP;
  }

  // Press events only stop Instagram's own handlers. preventDefault here would
  // also stop the chat from scrolling when a swipe happens to start on a Reel.
  function onPress(event) {
    if (recovering) { swallow(event); return; }
    pressStart = pointOf(event, false);
    if (isForbiddenTarget(event.target)) event.stopImmediatePropagation?.();
  }

  function onRelease(event) {
    if (recovering) { swallow(event); return; }
    if (!isForbiddenTarget(event.target)) return;
    event.stopImmediatePropagation?.();
    if (event.type === "touchend" && isTap(event)) {
      event.preventDefault?.(); // no synthetic click follows
      notice();
    }
  }

  function onActivate(event) {
    if (event.type === "keydown" && !["Enter", " ", "Spacebar"].includes(event.key)) return;
    if (recovering) { swallow(event); return; }
    if (!isForbiddenTarget(event.target)) return;
    swallow(event);
    notice();
  }

  function inspectModalMutations(records) {
    if (recovering || policy.classify(location.href) !== "messages") return;
    for (const record of records) {
      const target = asElement(record.target);
      const targetModal = closestModal(target);
      if (targetModal && (hasOwnReelSignal(target) || cardHasReelSignal(target) || cardHasReelSignal(targetModal))) {
        recover("reel"); return;
      }
      for (const node of record.addedNodes || []) {
        const element = asElement(node);
        const modal = closestModal(element) || boundedModalDescendant(element);
        if (modal && (hasOwnReelSignal(element) || cardHasReelSignal(element) || cardHasReelSignal(modal))) {
          recover("reel"); return;
        }
      }
    }
  }

  // Opening a Reel from a DM does not navigate: a full-screen player covers the
  // thread while the URL stays /direct/t/…, and swiping moves into suggested
  // Reels. So look for the player itself, independent of URL and markup: a
  // video spanning the viewport top to bottom. A video bubble inside a chat
  // never does.
  function coveringVideo() {
    const width = window.innerWidth || 0;
    const height = window.innerHeight || 0;
    if (!width || !height || typeof document.getElementsByTagName !== "function") return null;
    const videos = document.getElementsByTagName("video");
    for (let index = 0; index < videos.length; index++) {
      let rect;
      try { rect = videos[index].getBoundingClientRect(); } catch (_) { continue; }
      if (rect && rect.width > width * 0.5 && rect.top <= height * 0.15 && rect.bottom >= height * 0.85) {
        return videos[index];
      }
    }
    return null;
  }

  function silence(video) {
    try { video.muted = true; video.pause(); } catch (_) {}
  }

  function silenceVideos() {
    if (typeof document.getElementsByTagName !== "function") return;
    const videos = document.getElementsByTagName("video");
    for (let index = 0; index < videos.length; index++) silence(videos[index]);
  }

  function checkForReelPlayer() {
    if (recovering || policy.classify(location.href) !== "messages") return;
    if (coveringVideo()) recover("reel");
  }

  function enforceCurrentRoute() {
    attachStyle();
    lastHref = location.href;
    if (recovering) { hidePage(); return false; }
    const blocked = policy.classify(location.href) === "blocked";
    if (blocked) recover("blocked");
    else showPage();
    return !blocked;
  }

  function refreshNavigation() {
    pendingRefresh = false;
    if (!enforceCurrentRoute()) return;
    lockViewport();
    checkForReelPlayer();
    const isMessages = policy.classify(location.href) === "messages";
    // Hide routes only in navigation. Links in actual conversations keep their
    // text/preview, but clicking an unsupported destination is intercepted below.
    document.querySelectorAll('nav a[href], [role="navigation"] a[href]').forEach(link => {
      const hide = isMessages && policy.classify(link.href, location.href) === "blocked";
      if (hide && !link.hasAttribute("data-inbox-only-hidden")) link.setAttribute("data-inbox-only-hidden", "");
      if (!hide && link.hasAttribute("data-inbox-only-hidden")) link.removeAttribute("data-inbox-only-hidden");
    });
  }

  function queueRefresh() {
    if (!pendingRefresh) {
      pendingRefresh = true;
      requestAnimationFrame(refreshNavigation);
    }
  }

  function isAllowed(value) {
    return policy.classify(value, location.href) !== "blocked";
  }

  // Instagram is a single-page app; WKNavigationDelegate alone misses these.
  // Patch History.prototype when it exists so a router calling the prototype
  // method directly cannot step around an instance-level patch.
  function patchHistory(owner) {
    for (const method of ["pushState", "replaceState"]) {
      const original = owner[method];
      if (typeof original !== "function") continue;
      owner[method] = function (state, title, url) {
        // Refusing the URL does not stop the router rendering that page, so
        // reload the chat rather than leave it drawn under a /direct address.
        if (url != null && !isAllowed(url)) { recover("blocked"); return; }
        const result = original.apply(this, arguments);
        enforceCurrentRoute();
        queueRefresh();
        return result;
      };
    }
  }
  const historyPrototype = window.History?.prototype;
  if (historyPrototype && typeof historyPrototype.pushState === "function") patchHistory(historyPrototype);
  if (Object.prototype.hasOwnProperty.call(history, "pushState")) patchHistory(history);

  // Window capture runs before React's delegated handlers on document/root.
  const listeners = [
    [["pointerdown", "mousedown"], onPress, true],
    [["pointerup", "mouseup"], onRelease, true],
    [["click", "auxclick", "dblclick", "keydown"], onActivate, true],
  ];
  for (const target of [window, document]) {
    for (const [types, listener, options] of listeners) {
      for (const type of types) target.addEventListener(type, listener, options);
    }
    target.addEventListener("touchstart", onPress, { capture: true, passive: false });
    target.addEventListener("touchend", onRelease, { capture: true, passive: false });
  }
  document.addEventListener("submit", event => {
    const form = event.target;
    const action = event.submitter?.formAction || form.action || location.href;
    if (isAllowed(action)) return;
    swallow(event);
    notice();
  }, true);

  // Media events do not bubble, but capture listeners still see them.
  for (const type of ["play", "playing", "loadedmetadata"]) {
    document.addEventListener(type, event => {
      if (recovering) silence(event.target);
      else checkForReelPlayer();
    }, true);
  }

  // Keep permitted pop-ups in this view; blocked schemes cannot open Instagram.
  window.open = function (url) {
    if (!url) return null;
    if (isAllowed(url)) location.assign(new URL(url, location.href).href);
    else notice();
    return null;
  };

  window.addEventListener("popstate", () => { enforceCurrentRoute(); queueRefresh(); });
  window.addEventListener("hashchange", () => { enforceCurrentRoute(); queueRefresh(); });
  window.addEventListener("pageshow", () => { enforceCurrentRoute(); queueRefresh(); });
  window.addEventListener("resize", checkForReelPlayer);
  document.addEventListener("DOMContentLoaded", refreshNavigation);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { enforceCurrentRoute(); queueRefresh(); }
  });
  new MutationObserver(records => {
    inspectModalMutations(records);
    queueRefresh();
  }).observe(document, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["href", "role", "aria-label", "aria-modal", "title", "alt", "data-testid", "data-reel", "data-reel-id", "data-media-type", "data-media-kind", "data-type", "data-url", "data-href", "data-link"]
  });
  // Backstop for route changes no hook saw, and for a player that grows to
  // full screen through CSS alone, which produces no DOM mutation.
  if (typeof window.setInterval === "function") {
    window.setInterval(() => {
      if (location.href !== lastHref) { enforceCurrentRoute(); queueRefresh(); }
      checkForReelPlayer();
    }, 500);
  }

  // Native camera and photo buttons hand a JPEG to Instagram's own upload
  // control in the open chat, exactly as if it had been picked there.
  function isThreadRoute() {
    if (policy.classify(location.href) !== "messages") return false;
    try { return /^\/direct\/t\/[^/]+/.test(new URL(location.href).pathname); } catch (_) { return false; }
  }

  function findUploadInput() {
    let inputs = [];
    try { inputs = document.querySelectorAll('input[type="file"]'); } catch (_) {}
    for (const input of inputs) {
      if (input.disabled) continue;
      const accept = String(attribute(input, "accept") || "").toLowerCase();
      if (!accept || /image\/|\.jpe?g|\.png|\.heic/.test(accept)) return input;
    }
    return null;
  }

  function attachPhoto(base64) {
    if (recovering || !isThreadRoute()) return "not-in-thread";
    if (typeof base64 !== "string" || !base64) return "unsupported";
    const input = findUploadInput();
    if (!input) return "no-input";
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const file = new File([bytes], "photo.jpg", { type: "image/jpeg", lastModified: Date.now() });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) { return "unsupported"; }
    return "attached";
  }
  Object.defineProperty(window, "__inboxOnlyAttachPhoto", { value: attachPhoto });

  enforceCurrentRoute();
  queueRefresh();
  window.__inboxOnlyGuard = true;
})();

})();
