import UIKit
import WebKit

// WKUserContentController retains its message handler. Use a weak forwarding
// object so it does not retain the view controller through the web view.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

final class InboxViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var policy: NavigationPolicy?
    private var webView: WKWebView?
    private let container = UIView()
    private let cover = UIView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let status = UILabel()
    private let retry = UIButton(type: .system)
    private let notice = UILabel()
    private let privacyCover = UIView()
    private var redirectPending = false
    private var noticeDismissal: DispatchWorkItem?
    private var failedNavigation = false
    private var activeNavigation: WKNavigation?

    override func viewDidLoad() {
        super.viewDidLoad()
        buildInterface()
        do {
            let policy = try NavigationPolicy()
            self.policy = policy
            configureWebView(policy)
            loadInbox()
        } catch {
            showError("The app is missing its protection files. Rebuild and reinstall InboxOnly.")
            retry.isHidden = true
        }
        NotificationCenter.default.addObserver(self, selector: #selector(hideForPrivacy),
            name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(restoreAfterPrivacy),
            name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        noticeDismissal?.cancel()
    }

    private func buildInterface() {
        view.backgroundColor = .systemBackground
        let title = UILabel()
        title.text = "InboxOnly"
        title.font = .systemFont(ofSize: 22, weight: .bold)
        title.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let inbox = iconButton("tray", label: "Return to inbox", action: #selector(loadInbox))
        let refresh = iconButton("arrow.clockwise", label: "Reload messages", action: #selector(reloadPage))
        let settings = iconButton("ellipsis.circle", label: "Settings", action: #selector(showSettings))
        let header = UIStackView(arrangedSubviews: [title, inbox, refresh, settings])
        header.axis = .horizontal
        header.spacing = 10
        header.alignment = .center
        header.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(header)
        container.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(container)
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            header.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 18),
            header.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            header.heightAnchor.constraint(equalToConstant: 56),
            container.topAnchor.constraint(equalTo: header.bottomAnchor),
            container.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            container.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            container.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])

        cover.backgroundColor = .systemBackground
        pin(cover, to: container)
        status.text = "Opening your inbox…"
        status.numberOfLines = 0
        status.textAlignment = .center
        status.textColor = .secondaryLabel
        status.font = .preferredFont(forTextStyle: .body)
        retry.setTitle("Try again", for: .normal)
        retry.addTarget(self, action: #selector(loadInbox), for: .touchUpInside)
        retry.isHidden = true
        let feedback = UIStackView(arrangedSubviews: [spinner, status, retry])
        feedback.axis = .vertical
        feedback.spacing = 18
        feedback.alignment = .center
        feedback.translatesAutoresizingMaskIntoConstraints = false
        cover.addSubview(feedback)
        NSLayoutConstraint.activate([
            feedback.centerXAnchor.constraint(equalTo: cover.centerXAnchor),
            feedback.centerYAnchor.constraint(equalTo: cover.centerYAnchor),
            feedback.leadingAnchor.constraint(greaterThanOrEqualTo: cover.leadingAnchor, constant: 28),
            feedback.trailingAnchor.constraint(lessThanOrEqualTo: cover.trailingAnchor, constant: -28),
            status.widthAnchor.constraint(lessThanOrEqualToConstant: 330)
        ])
        notice.text = "Only messages can open here."
        notice.font = .preferredFont(forTextStyle: .footnote)
        notice.textAlignment = .center
        notice.textColor = .white
        notice.backgroundColor = .systemIndigo
        notice.isHidden = true
        notice.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(notice)
        NSLayoutConstraint.activate([
            notice.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            notice.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            notice.topAnchor.constraint(equalTo: container.topAnchor),
            notice.heightAnchor.constraint(equalToConstant: 36)
        ])
        privacyCover.backgroundColor = .systemBackground
        pin(privacyCover, to: view)
        let privacyLabel = UILabel()
        privacyLabel.text = "InboxOnly"
        privacyLabel.font = .systemFont(ofSize: 28, weight: .bold)
        privacyLabel.translatesAutoresizingMaskIntoConstraints = false
        privacyCover.addSubview(privacyLabel)
        NSLayoutConstraint.activate([
            privacyLabel.centerXAnchor.constraint(equalTo: privacyCover.centerXAnchor),
            privacyLabel.centerYAnchor.constraint(equalTo: privacyCover.centerYAnchor)
        ])
        privacyCover.isHidden = true
    }

    private func pin(_ child: UIView, to parent: UIView) {
        child.translatesAutoresizingMaskIntoConstraints = false
        parent.addSubview(child)
        NSLayoutConstraint.activate([
            child.topAnchor.constraint(equalTo: parent.topAnchor),
            child.bottomAnchor.constraint(equalTo: parent.bottomAnchor),
            child.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
            child.trailingAnchor.constraint(equalTo: parent.trailingAnchor)
        ])
    }

    private func iconButton(_ symbol: String, label: String, action: Selector) -> UIButton {
        let button = UIButton(type: .system)
        button.setImage(UIImage(systemName: symbol), for: .normal)
        button.accessibilityLabel = label
        button.addTarget(self, action: action, for: .touchUpInside)
        button.widthAnchor.constraint(equalToConstant: 44).isActive = true
        button.heightAnchor.constraint(equalToConstant: 44).isActive = true
        return button
    }

    private func configureWebView(_ policy: NavigationPolicy) {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: policy.script,
            injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        controller.add(WeakMessageHandler(self), name: "inboxOnly")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        pin(webView, to: container)
        container.sendSubviewToBack(webView)
        self.webView = webView
    }

    private func beginLoading() {
        failedNavigation = false
        cover.isHidden = false
        status.text = "Opening your inbox…"
        retry.isHidden = true
        spinner.startAnimating()
    }

    @objc private func loadInbox() {
        guard let policy, let webView else { return }
        beginLoading()
        activeNavigation = webView.load(URLRequest(url: policy.rules.inboxURL))
    }

    @objc private func reloadPage() {
        guard let policy, let webView, let url = webView.url,
              policy.classify(url) != .blocked else { loadInbox(); return }
        beginLoading()
        activeNavigation = webView.reload()
    }

    private func showError(_ text: String) {
        failedNavigation = true
        spinner.stopAnimating()
        status.text = text
        retry.isHidden = false
        cover.isHidden = false
    }

    private func showBlockedNotice() {
        noticeDismissal?.cancel()
        notice.isHidden = false
        UIAccessibility.post(notification: .announcement, argument: "Only messages can open here.")
        let work = DispatchWorkItem { [weak self] in self?.notice.isHidden = true }
        noticeDismissal = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
    }

    private func returnToInbox() {
        showBlockedNotice()
        cover.isHidden = false
        guard !redirectPending else { return }
        redirectPending = true
        // Never start a new navigation inside a policy decision callback.
        DispatchQueue.main.async { [weak self] in
            self?.redirectPending = false
            self?.loadInbox()
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Navigation policy is for pages, not image/video requests or challenge
        // frames. Inspect any attempt by a child frame to navigate the main frame.
        if let target = navigationAction.targetFrame, !target.isMainFrame {
            decisionHandler(.allow)
            return
        }
        guard let policy, let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        guard policy.classify(url) != .blocked else {
            decisionHandler(.cancel)
            returnToInbox()
            return
        }
        if navigationAction.targetFrame == nil {
            decisionHandler(.cancel)
            beginLoading()
            activeNavigation = webView.load(navigationAction.request)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard navigationResponse.isForMainFrame else { decisionHandler(.allow); return }
        guard let policy, let url = navigationResponse.response.url,
              policy.classify(url) != .blocked else {
            decisionHandler(.cancel)
            returnToInbox()
            return
        }
        if let response = navigationResponse.response as? HTTPURLResponse, response.statusCode >= 400 {
            decisionHandler(.cancel)
            showError("Instagram couldn't open this page. Try again in a moment.")
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        activeNavigation = navigation
        beginLoading()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard navigation === activeNavigation, !failedNavigation, let policy, let url = webView.url,
              policy.classify(url) != .blocked else { return }
        webView.evaluateJavaScript("window.__inboxOnlyGuard === true") { [weak self] result, error in
            guard let self, navigation === self.activeNavigation, !self.failedNavigation, !webView.isLoading,
                  let currentURL = webView.url, policy.classify(currentURL) != .blocked else { return }
            guard error == nil, result as? Bool == true else {
                self.showError("Message-only protection didn't load. Tap Try again to reload it.")
                return
            }
            self.spinner.stopAnimating()
            self.cover.isHidden = true
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if navigation === activeNavigation { handleNavigationError(error) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if navigation === activeNavigation { handleNavigationError(error) }
    }

    private func handleNavigationError(_ error: Error) {
        // A cancelled blocked navigation must not overwrite the replacement load.
        if redirectPending || (error as NSError).code == NSURLErrorCancelled { return }
        showError("Couldn't load Instagram. Check your connection, then try again.")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showError("The page closed unexpectedly. Tap Try again to reopen your inbox.")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.body as? String == "blocked" else { return }
        returnToInbox()
    }

    // Defensive fallback for new-window requests; never create an unfiltered view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let policy, let url = navigationAction.request.url, policy.classify(url) != .blocked else {
            returnToInbox()
            return nil
        }
        if navigationAction.targetFrame == nil {
            beginLoading()
            activeNavigation = webView.load(navigationAction.request)
        }
        return nil
    }

    @objc private func hideForPrivacy() { privacyCover.isHidden = false }
    @objc private func restoreAfterPrivacy() { privacyCover.isHidden = true }

    @objc private func showSettings() {
        let sheet = UIAlertController(title: "InboxOnly", message: "Your conversations, without the scrolling.", preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "About & limitations", style: .default) { [weak self] _ in
            let about = UIAlertController(title: "About InboxOnly", message:
                "An independent, personal-use Instagram web client. Not affiliated with Instagram or Meta.\n\nSign in on Instagram's own page. Login stays in this app's web storage. InboxOnly has no server, analytics, subscriptions or message-reading code.\n\nNo push notifications or guaranteed call support. Feed, Reels, profiles, posts and external links cannot open here. Shared-media previews may still appear inside chats.\n\nInstagram changes can break login or filtering. This does not block the original Instagram app.", preferredStyle: .alert)
            about.addAction(UIAlertAction(title: "OK", style: .default))
            self?.present(about, animated: true)
        })
        sheet.addAction(UIAlertAction(title: "Clear login on this device", style: .destructive) { [weak self] _ in
            self?.confirmClearLogin()
        })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.maxX - 40, y: view.safeAreaInsets.top + 44, width: 1, height: 1)
        present(sheet, animated: true)
    }

    private func confirmClearLogin() {
        let alert = UIAlertController(title: "Clear saved login?", message: "This removes InboxOnly's local cookies and website data. It does not delete your Instagram account or conversations.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Clear login", style: .destructive) { [weak self] _ in
            guard let self, let webView = self.webView else { return }
            webView.stopLoading()
            self.beginLoading()
            webView.configuration.websiteDataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
                modifiedSince: .distantPast) { [weak self] in self?.loadInbox() }
        })
        present(alert, animated: true)
    }
}
