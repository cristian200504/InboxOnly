// ==UserScript==
// @name         InboxOnly - Instagram messages
// @namespace    inboxonly.local
// @version      1.0.0
// @description  Keep Instagram messages; redirect feed, Reels, Explore and profile navigation.
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
  let redirecting = false;
  let pendingRefresh = false;
  let lastNotice = 0;
  const style = document.createElement("style");
  style.id = "inbox-only-style";
  style.textContent = `
    html[data-inbox-only-blocked] { visibility: hidden !important; }
    a[data-inbox-only-hidden] { display: none !important; }
  `;

  function notify() {
    // Only a fixed event is sent to Swift: never URLs, passwords or chat content.
    if (Date.now() - lastNotice < 800) return;
    lastNotice = Date.now();
    const nativeHandler = window.webkit?.messageHandlers?.inboxOnly;
    if (nativeHandler) {
      try { nativeHandler.postMessage("blocked"); } catch (_) {}
    } else if (!redirecting) {
      // Safari userscript: reset the page as well, so a React click handler
      // cannot leave feed content rendered under an unchanged /direct URL.
      redirecting = true;
      location.replace(policy.inboxURL);
    }
  }

  function attachStyle() {
    if (!style.isConnected && document.documentElement) document.documentElement.appendChild(style);
  }

  function enforceCurrentRoute() {
    attachStyle();
    const blocked = policy.classify(location.href) === "blocked";
    const html = document.documentElement;
    if (html) {
      if (blocked && !html.hasAttribute("data-inbox-only-blocked")) html.setAttribute("data-inbox-only-blocked", "");
      if (!blocked && html.hasAttribute("data-inbox-only-blocked")) html.removeAttribute("data-inbox-only-blocked");
    }
    if (blocked && !redirecting) {
      redirecting = true;
      notify();
      location.replace(policy.inboxURL);
    }
    return !blocked;
  }

  function refreshNavigation() {
    pendingRefresh = false;
    if (!enforceCurrentRoute()) return;
    const isInbox = policy.classify(location.href) === "messages";
    // Hide routes only in navigation. Links in actual conversations keep their
    // text/preview, but clicking an unsupported destination is intercepted below.
    document.querySelectorAll('nav a[href], [role="navigation"] a[href]').forEach(link => {
      const hide = isInbox && policy.classify(link.href, location.href) === "blocked";
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

  function allowedNavigation(value) {
    if (policy.classify(value, location.href) !== "blocked") return true;
    notify();
    return false;
  }

  // Instagram is a single-page app; WKNavigationDelegate alone misses these.
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (state, title, url) {
      if (url != null && !allowedNavigation(url)) return;
      const result = original.apply(this, arguments);
      enforceCurrentRoute();
      queueRefresh();
      return result;
    };
  }

  const interceptLink = event => {
    const target = event.target;
    const link = target && typeof target.closest === "function" ? target.closest("a[href]") : null;
    if (!link || allowedNavigation(link.href)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener("click", interceptLink, true);
  document.addEventListener("auxclick", interceptLink, true);
  document.addEventListener("submit", event => {
    const form = event.target;
    const action = event.submitter?.formAction || form.action || location.href;
    if (allowedNavigation(action)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  // Keep permitted pop-ups in this view; blocked schemes cannot open Instagram.
  window.open = function (url) {
    if (url && allowedNavigation(url)) location.assign(new URL(url, location.href).href);
    return null;
  };

  window.addEventListener("popstate", () => { enforceCurrentRoute(); queueRefresh(); });
  window.addEventListener("hashchange", () => { enforceCurrentRoute(); queueRefresh(); });
  window.addEventListener("pageshow", () => { enforceCurrentRoute(); queueRefresh(); });
  document.addEventListener("DOMContentLoaded", refreshNavigation);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { enforceCurrentRoute(); queueRefresh(); }
  });
  new MutationObserver(queueRefresh).observe(document, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["href", "role"]
  });
  enforceCurrentRoute();
  queueRefresh();
  window.__inboxOnlyGuard = true;
})();

})();
