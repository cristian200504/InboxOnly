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
