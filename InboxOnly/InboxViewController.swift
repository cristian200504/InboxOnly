import AVFoundation
import PhotosUI
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

// WebKit puts a "‹ › Done" bar above the keyboard for web text fields, which no
// native messenger has. Swap the web view's content view for a runtime subclass
// whose inputAccessoryView is nil, as Cordova's keyboard plugin does. If WebKit's
// internals ever change, the lookup finds nothing and the bar simply stays.
private final class NoInputAccessory: NSObject {
    @objc var inputAccessoryView: AnyObject? { nil }
}

private func hideFormAccessoryBar(in webView: WKWebView) {
    guard let contentView = webView.scrollView.subviews.first(where: {
        NSStringFromClass(type(of: $0)).hasPrefix("WKContent")
    }) else { return }
    let baseClass: AnyClass = type(of: contentView)
    let name = NSStringFromClass(baseClass) + "_InboxOnlyNoAccessory"
    if let existing = NSClassFromString(name) {
        object_setClass(contentView, existing)
        return
    }
    guard let method = class_getInstanceMethod(NoInputAccessory.self,
                                               #selector(getter: NoInputAccessory.inputAccessoryView)),
          let subclass = objc_allocateClassPair(baseClass, name, 0) else { return }
    class_addMethod(subclass, #selector(getter: UIResponder.inputAccessoryView),
                    method_getImplementation(method), method_getTypeEncoding(method))
    objc_registerClassPair(subclass)
    object_setClass(contentView, subclass)
}

private extension UIColor {
    /// Whether light text reads better on this colour; nil when mostly transparent.
    var isDark: Bool? {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        guard getRed(&red, green: &green, blue: &blue, alpha: &alpha), alpha > 0.5 else { return nil }
        return 0.299 * red + 0.587 * green + 0.114 * blue < 0.5
    }
}

final class InboxViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler,
    PHPickerViewControllerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    private enum Notice {
        static let messagesOnly = "Only messages can open here."
        static let reels = "Reels can't be opened here."
    }

    private var policy: NavigationPolicy?
    private var webView: WKWebView?
    private let container = UIView()
    private let bottomBar = UIView()
    private let toolbar = UIToolbar()
    private let cover = UIView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let status = UILabel()
    private let retry = UIButton(type: .system)
    private let noticeView = UIView()
    private let noticeLabel = UILabel()
    private let privacyCover = UIView()
    private var cameraItem: UIBarButtonItem?
    private var photoItem: UIBarButtonItem?
    private var redirectPending = false
    private var recoveries: [Date] = []
    private var noticeDismissal: DispatchWorkItem?
    private var failedNavigation = false
    private var activeNavigation: WKNavigation?
    private var urlObservation: NSKeyValueObservation?
    private var colorObservation: NSKeyValueObservation?
    private var statusBarStyle: UIStatusBarStyle = .default

    override var preferredStatusBarStyle: UIStatusBarStyle { statusBarStyle }

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

    // MARK: Interface

    // The page runs edge to edge between the status bar and a native bottom bar.
    // Both take the page's own background colour, so it reads as one app rather
    // than a website inside a frame.
    private func buildInterface() {
        view.backgroundColor = .systemBackground
        container.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(container)

        bottomBar.backgroundColor = .systemBackground
        bottomBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bottomBar)
        let separator = UIView()
        separator.backgroundColor = .separator
        separator.translatesAutoresizingMaskIntoConstraints = false
        bottomBar.addSubview(separator)
        let appearance = UIToolbarAppearance()
        appearance.configureWithTransparentBackground()
        toolbar.standardAppearance = appearance
        toolbar.compactAppearance = appearance
        toolbar.scrollEdgeAppearance = appearance
        toolbar.tintColor = .label
        toolbar.items = makeToolbarItems()
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        bottomBar.addSubview(toolbar)

        NSLayoutConstraint.activate([
            container.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            container.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            container.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            container.bottomAnchor.constraint(equalTo: bottomBar.topAnchor),
            bottomBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bottomBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bottomBar.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            separator.topAnchor.constraint(equalTo: bottomBar.topAnchor),
            separator.leadingAnchor.constraint(equalTo: bottomBar.leadingAnchor),
            separator.trailingAnchor.constraint(equalTo: bottomBar.trailingAnchor),
            separator.heightAnchor.constraint(equalToConstant: 0.5),
            toolbar.topAnchor.constraint(equalTo: bottomBar.topAnchor),
            toolbar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            toolbar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            toolbar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])

        cover.backgroundColor = .systemBackground
        pin(cover, to: container)
        status.text = "Opening your inbox…"
        status.numberOfLines = 0
        status.textAlignment = .center
        status.textColor = .secondaryLabel
        status.font = .preferredFont(forTextStyle: .body)
        retry.setTitle("Try again", for: .normal)
        retry.addTarget(self, action: #selector(openInbox), for: .touchUpInside)
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

        noticeView.backgroundColor = UIColor.black.withAlphaComponent(0.8)
        noticeView.layer.cornerRadius = 17
        noticeView.isUserInteractionEnabled = false
        noticeView.isHidden = true
        noticeView.translatesAutoresizingMaskIntoConstraints = false
        noticeLabel.font = .preferredFont(forTextStyle: .footnote)
        noticeLabel.textColor = .white
        noticeLabel.textAlignment = .center
        noticeLabel.numberOfLines = 0
        noticeLabel.translatesAutoresizingMaskIntoConstraints = false
        noticeView.addSubview(noticeLabel)
        container.addSubview(noticeView)
        NSLayoutConstraint.activate([
            noticeLabel.topAnchor.constraint(equalTo: noticeView.topAnchor, constant: 9),
            noticeLabel.bottomAnchor.constraint(equalTo: noticeView.bottomAnchor, constant: -9),
            noticeLabel.leadingAnchor.constraint(equalTo: noticeView.leadingAnchor, constant: 16),
            noticeLabel.trailingAnchor.constraint(equalTo: noticeView.trailingAnchor, constant: -16),
            noticeView.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            noticeView.topAnchor.constraint(equalTo: container.topAnchor, constant: 10),
            noticeView.widthAnchor.constraint(lessThanOrEqualTo: container.widthAnchor, constant: -32)
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

    private func makeToolbarItems() -> [UIBarButtonItem] {
        let inbox = UIBarButtonItem(image: UIImage(systemName: "bubble.left.and.bubble.right"), style: .plain,
                                    target: self, action: #selector(openInbox))
        inbox.accessibilityLabel = "Inbox"
        let camera = UIBarButtonItem(image: UIImage(systemName: "camera"), style: .plain,
                                     target: self, action: #selector(openCamera))
        camera.accessibilityLabel = "Take a photo for this chat"
        let photo = UIBarButtonItem(image: UIImage(systemName: "photo.on.rectangle"), style: .plain,
                                    target: self, action: #selector(openPhotoLibrary))
        photo.accessibilityLabel = "Send a photo from your library"
        let more = UIBarButtonItem(title: nil, image: UIImage(systemName: "ellipsis.circle"),
                                   primaryAction: nil, menu: makeMenu())
        more.accessibilityLabel = "More"
        camera.isEnabled = false
        photo.isEnabled = false
        cameraItem = camera
        photoItem = photo
        return [inbox, .flexibleSpace(), camera, .fixedSpace(32), photo, .flexibleSpace(), more]
    }

    private func makeMenu() -> UIMenu {
        UIMenu(children: [
            UIAction(title: "Reload", image: UIImage(systemName: "arrow.clockwise")) { [weak self] _ in
                self?.reloadPage()
            },
            UIAction(title: "About InboxOnly", image: UIImage(systemName: "info.circle")) { [weak self] _ in
                self?.showAbout()
            },
            UIAction(title: "Clear login on this device", image: UIImage(systemName: "person.crop.circle.badge.xmark"),
                     attributes: .destructive) { [weak self] _ in
                self?.confirmClearLogin()
            }
        ])
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
        // Identify as Safari. A bare WKWebView user agent can get a reduced
        // mobile page from Instagram, which may lack attachment controls.
        configuration.applicationNameForUserAgent = "Version/18.0 Mobile/15E148 Safari/604.1"
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // Swipe from the left edge to go back from a chat to the inbox, as in a
        // native messenger. Every step back is still route-checked.
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        pin(webView, to: container)
        container.sendSubviewToBack(webView)
        hideFormAccessoryBar(in: webView)
        self.webView = webView
        // Same-document route changes (history.pushState) never reach the
        // navigation delegate, so back up the injected guard with the URL WebKit
        // actually committed.
        urlObservation = webView.observe(\.url, options: [.new]) { [weak self] webView, _ in
            self?.urlDidChange(in: webView)
        }
        colorObservation = webView.observe(\.underPageBackgroundColor, options: [.initial, .new]) { [weak self] webView, _ in
            self?.applyPageColor(of: webView)
        }
    }

    private func applyPageColor(of webView: WKWebView) {
        guard let color = webView.underPageBackgroundColor, let dark = color.isDark else { return }
        let style: UIUserInterfaceStyle = dark ? .dark : .light
        view.backgroundColor = color
        bottomBar.backgroundColor = color
        cover.backgroundColor = color
        bottomBar.overrideUserInterfaceStyle = style
        cover.overrideUserInterfaceStyle = style
        let barStyle: UIStatusBarStyle = dark ? .lightContent : .darkContent
        if barStyle != statusBarStyle {
            statusBarStyle = barStyle
            setNeedsStatusBarAppearanceUpdate()
        }
    }

    private var currentMessagesURL: URL? {
        guard let policy, let url = webView?.url, policy.classify(url) == .messages else { return nil }
        return url
    }

    private var isInThread: Bool {
        currentMessagesURL?.path.hasPrefix("/direct/t/") ?? false
    }

    private func updateComposerTools() {
        let enabled = isInThread
        cameraItem?.isEnabled = enabled
        photoItem?.isEnabled = enabled
    }

    private func urlDidChange(in webView: WKWebView) {
        updateComposerTools()
        // Only https pages are judged: about:blank and other transient states
        // must not trigger a redirect.
        guard let policy, let url = webView.url, url.scheme?.lowercased() == "https",
              policy.classify(url) == .blocked else { return }
        recover(notice: Notice.messagesOnly)
    }

    // MARK: Loading

    private func beginLoading() {
        failedNavigation = false
        cover.isHidden = false
        status.text = "Opening your inbox…"
        retry.isHidden = true
        spinner.startAnimating()
    }

    private func load(_ url: URL) {
        guard let webView else { return }
        beginLoading()
        activeNavigation = webView.load(URLRequest(url: url))
    }

    private func loadInbox() {
        guard let policy else { return }
        load(policy.rules.inboxURL)
    }

    @objc private func openInbox() {
        recoveries.removeAll()
        loadInbox()
    }

    @objc private func reloadPage() {
        guard let policy, let webView, let url = webView.url,
              policy.classify(url) != .blocked else { openInbox(); return }
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

    private func showNotice(_ text: String) {
        noticeDismissal?.cancel()
        noticeLabel.text = text
        noticeView.isHidden = false
        UIAccessibility.post(notification: .announcement, argument: text)
        let work = DispatchWorkItem { [weak self] in self?.noticeView.isHidden = true }
        noticeDismissal = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: work)
    }

    /// Something forbidden was reached or began rendering. Reopen the chat that
    /// was open (the inbox if there wasn't one, or if this keeps happening).
    private func recover(notice text: String) {
        showNotice(text)
        cover.isHidden = false
        guard !redirectPending else { return }
        redirectPending = true
        let now = Date()
        recoveries = recoveries.filter { now.timeIntervalSince($0) < 20 } + [now]
        let chat = recoveries.count < 3 ? currentMessagesURL : nil
        let givingUp = recoveries.count >= 6
        // Never start a new navigation inside a policy decision callback.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.redirectPending = false
            if givingUp {
                self.showError("Instagram keeps leaving your messages. Tap Try again to reopen the inbox.")
            } else if let chat {
                self.load(chat)
            } else {
                self.loadInbox()
            }
        }
    }

    // MARK: Navigation policy

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let policy, let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        // Navigation policy is for pages, not image/video requests or challenge
        // frames. Cancel app-opening schemes and embedded Reel viewers in child
        // frames quietly, so a retrying embed cannot reload the inbox in a loop.
        if let target = navigationAction.targetFrame, !target.isMainFrame {
            decisionHandler(policy.blocksEmbeddedNavigation(url) ? .cancel : .allow)
            return
        }
        guard policy.classify(url) != .blocked else {
            decisionHandler(.cancel)
            // A cancelled link leaves the visible chat untouched; reload only when
            // nothing permitted is on screen yet.
            if cover.isHidden { showNotice(Notice.messagesOnly) } else { recover(notice: Notice.messagesOnly) }
            return
        }
        // Explicit loads stay in this WKWebView rather than following a tapped
        // universal link into the installed Instagram app. Keep POST/auth forms
        // untouched so their method, body and normal navigation are preserved.
        let isTappedLink = navigationAction.navigationType == .linkActivated &&
            (navigationAction.request.httpMethod ?? "GET").uppercased() == "GET"
        if navigationAction.targetFrame == nil || isTappedLink {
            decisionHandler(.cancel)
            DispatchQueue.main.async { [weak self, weak webView] in
                guard let self, let webView else { return }
                self.beginLoading()
                self.activeNavigation = webView.load(navigationAction.request)
            }
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard navigationResponse.isForMainFrame else {
            let shouldBlock = navigationResponse.response.url.map { policy?.blocksEmbeddedNavigation($0) ?? true } ?? true
            decisionHandler(shouldBlock ? .cancel : .allow)
            return
        }
        guard let policy, let url = navigationResponse.response.url,
              policy.classify(url) != .blocked else {
            decisionHandler(.cancel)
            recover(notice: Notice.messagesOnly)
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
        applyPageColor(of: webView)
        updateComposerTools()
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
        guard message.frameInfo.isMainFrame, let event = message.body as? String else { return }
        switch event {
        case "notice": showNotice(Notice.messagesOnly)
        case "reel": recover(notice: Notice.reels)
        case "blocked": recover(notice: Notice.messagesOnly)
        default: break
        }
    }

    // Defensive fallback for new-window requests; never create an unfiltered view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let policy, let url = navigationAction.request.url, policy.classify(url) != .blocked else {
            showNotice(Notice.messagesOnly)
            return nil
        }
        if navigationAction.targetFrame == nil {
            beginLoading()
            activeNavigation = webView.load(navigationAction.request)
        }
        return nil
    }

    // MARK: Camera and photos

    // Instagram's website has no in-page camera, and its mobile layout may hide
    // the attachment button. These native buttons hand a photo to the page's own
    // upload control in the open chat, so it is sent by Instagram as usual.
    @objc private func openCamera() {
        guard isInThread else { return }
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            showAlert("No camera available", "This device has no camera InboxOnly can use.")
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            presentCamera()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted { self?.presentCamera() } else { self?.showCameraDenied() }
                }
            }
        default:
            showCameraDenied()
        }
    }

    private func presentCamera() {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = self
        present(picker, animated: true)
    }

    private func showCameraDenied() {
        let alert = UIAlertController(title: "Camera access is off",
            message: "Allow camera access for InboxOnly in Settings to take photos for your chats.",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Open Settings", style: .default) { _ in
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        })
        present(alert, animated: true)
    }

    @objc private func openPhotoLibrary() {
        guard isInThread else { return }
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = 1
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        present(picker, animated: true)
    }

    func imagePickerController(_ picker: UIImagePickerController,
                               didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        let image = info[.originalImage] as? UIImage
        picker.dismiss(animated: true) { [weak self] in
            if let image { self?.attachPhoto(image) }
        }
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider else { return }
        guard provider.canLoadObject(ofClass: UIImage.self) else {
            showAlert("That item can't be sent", "Choose a photo instead.")
            return
        }
        provider.loadObject(ofClass: UIImage.self) { [weak self] object, _ in
            let image = object as? UIImage
            DispatchQueue.main.async {
                if let image { self?.attachPhoto(image) } else {
                    self?.showAlert("Couldn't open that photo", "Try a different photo.")
                }
            }
        }
    }

    private func attachPhoto(_ image: UIImage) {
        guard let webView, isInThread else {
            showAlert("Open a chat first", "Photos are added to the conversation that's open.")
            return
        }
        guard let data = Self.jpegData(for: image) else {
            showAlert("Couldn't prepare the photo", "Try a different photo.")
            return
        }
        webView.callAsyncJavaScript("return window.__inboxOnlyAttachPhoto(photo);",
                                    arguments: ["photo": data.base64EncodedString()],
                                    in: nil, in: .page) { [weak self] result in
            let outcome = ((try? result.get()) as? String) ?? ""
            switch outcome {
            case "attached":
                break
            case "not-in-thread":
                self?.showAlert("Open a chat first", "Photos are added to the conversation that's open.")
            case "no-input":
                self?.showAlert("Instagram didn't offer a photo upload here",
                    "Instagram only allows photos once someone has accepted your message request. If they have, Instagram's site may have changed and InboxOnly needs an update.")
            default:
                self?.showAlert("Couldn't attach the photo", "Instagram's page didn't accept it. Reload and try again.")
            }
        }
    }

    // Downscale before crossing into the page: Instagram resizes anyway, and a
    // 12-megapixel original would be a very large string to hand over.
    private static func jpegData(for image: UIImage, maxDimension: CGFloat = 2048) -> Data? {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = min(1, maxDimension / max(size.width, size.height))
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return resized.jpegData(compressionQuality: 0.85)
    }

    private func showAlert(_ title: String, _ message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }

    // MARK: Privacy and settings

    @objc private func hideForPrivacy() { privacyCover.isHidden = false }
    @objc private func restoreAfterPrivacy() { privacyCover.isHidden = true }

    private func showAbout() {
        showAlert("About InboxOnly",
            "An independent, personal-use Instagram web client. Not affiliated with Instagram or Meta.\n\nSign in on Instagram's own page. Login stays in this app's web storage. InboxOnly has no server, analytics, subscriptions or message-reading code.\n\nFeed, Reels, profiles, posts and outside links can't open here, and a Reel sent to you won't play. A video that opens full screen is closed too.\n\nThe camera and photo buttons add a normal photo to the open chat. Instagram's website can't send view-once photos, and there are no push notifications or guaranteed calls.\n\nInstagram changes can break login or filtering. This does not block the original Instagram app.")
    }

    private func confirmClearLogin() {
        let alert = UIAlertController(title: "Clear saved login?", message: "This removes InboxOnly's local cookies and website data. It does not delete your Instagram account or conversations.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Clear login", style: .destructive) { [weak self] _ in
            guard let self, let webView = self.webView else { return }
            webView.stopLoading()
            self.beginLoading()
            webView.configuration.websiteDataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
                modifiedSince: .distantPast) { [weak self] in self?.openInbox() }
        })
        present(alert, animated: true)
    }
}
