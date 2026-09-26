# InboxOnly

A free personal project that opens Instagram messages and blocks navigation to the feed, Reels, Explore, posts, stories and profiles. It uses Instagram's real website, with your existing account and conversations. It is independent of Instagram, Meta and Konvo. No subscription, backend, private Instagram API or paid SDK.

**Status: source prototype.** The route filter and browser guard are tested locally with Node. The native iPhone app has not been compiled or tested on an iPhone here: this workspace is on Windows. The included GitHub workflow performs the native build. Instagram login, actual messaging, attachments and current website compatibility still need on-device testing.

There are two ways to use the same filter:

| | Safari script | Standalone iPhone app |
| --- | --- | --- |
| Cost | Free Userscripts extension | Free personal sideloading |
| Mac required | No | No: compile on a GitHub macOS runner |
| Installation | Copy one script into Files | Build an IPA, then sign/install with AltStore Classic |
| Maintenance | Update script when Instagram changes | Same, plus refresh signing every 7 days |
| Works in | Safari tabs with extension enabled | InboxOnly app only |

## Easiest free test: Safari

1. Install [Userscripts by Justin Wasack](https://apps.apple.com/ro/app/userscripts/id1463298887), currently listed as free in the Romanian App Store. Use an up-to-date iOS version.
2. Transfer `dist/InboxOnly.user.js` from this project to your iPhone's Files app, for example using your own iCloud Drive. Keep the `.user.js` extension; it must not become `.txt`.
3. Open Userscripts and choose its scripts directory. Put `InboxOnly.user.js` directly in that directory. See the [official iOS setup instructions](https://github.com/quoid/userscripts#usage) if the script is not detected.
4. In iPhone Settings, find **Safari > Extensions > Userscripts** (Safari may be under Apps). Enable it and allow it on `instagram.com`. In Safari's extensions menu, confirm **InboxOnly - Instagram messages** is enabled.
5. Open [your Instagram inbox](https://www.instagram.com/direct/inbox/) **in Safari** and log in normally, including 2FA. Use your Instagram username/password; the prototype does not support Facebook sign-in.
6. Try opening Reels, Explore and a profile. They should return to your inbox. Verify you can read and send messages. Test a Reel link sent in a conversation too.

Keep this in a normal Safari tab or bookmark. Do not assume an “Add to Home Screen” standalone web app inherits Safari's extensions. This script cannot protect the native Instagram app, other browsers, or tabs where Userscripts is disabled. You can remove the native Instagram app yourself after testing if that helps prevent the habit.

The Safari version has weaker enforcement than the native wrapper: an extension can inject late or be blocked by page policy, native “open app” prompts may escape it, and a momentary feed flash is possible. If it fails to redirect, stop using that page and check the extension. This is a voluntary focus aid, not a tamper-proof restriction.

## Your own native app, built from Windows

The Swift source is in `InboxOnly/`. Open `InboxOnly.xcodeproj` on a Mac if one becomes available. The app targets iOS 16 or later.

For Windows-only development, compile on GitHub, then install locally:

1. Create a new **public** GitHub repository containing **only this project's source**. Public means anyone can read it. Upload the `InboxOnly`, `InboxOnly.xcodeproj`, `.github`, `scripts`, and `tests` directories plus `package.json`, `.gitignore` and this README, preserving their paths. Never add Apple/Instagram passwords, cookies, provisioning profiles or other personal files. No secrets are needed by this workflow.
2. In that repository, open **Actions > Build unsigned iPhone app > Run workflow**. The workflow must be on the default branch. Standard GitHub-hosted macOS runners are [free for public repositories](https://docs.github.com/en/actions/reference/runners/github-hosted-runners); private repositories have different quotas. Keep the standard runner configured in the workflow.
3. Wait for a successful build. Open that run and download the **InboxOnly-unsigned** artifact. Extract its ZIP to get `InboxOnly-unsigned.ipa`. This is an unsigned app: tapping it alone cannot install it.
4. Install **AltStore Classic** using its [official Windows guide](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows). This includes AltServer, Apple's iTunes/iCloud requirements, pairing/trusting your iPhone and enabling Developer Mode when required. Use Classic, not AltStore PAL, for an arbitrary IPA.
5. Transfer the IPA to Files on your phone. In AltStore's **My Apps**, use **+** and choose the IPA. AltStore signs it using your own Apple Account. Enter credentials only in the official installation tools, never into this project or GitHub.
6. Open InboxOnly and log into Instagram on the Instagram page. Run the manual checks below before relying on it.
7. Refresh the app through AltStore before its seven-day signature expires. See [AltStore's refresh guide](https://faq.altstore.io/altstore-classic/your-altstore). Apple's free personal provisioning has a [seven-day expiry and active-app limits](https://developer.apple.com/help/account/basics/about-your-developer-account). AltStore itself uses a sideloaded app slot.

No repository has been created/published and no GitHub build has been run as part of generating this project. The workflow is manual, uses no signing credentials and uploads no account data. It produces an installable package only after a successful compile and subsequent local signing.

### If you get access to a Mac

Open the Xcode project, select your connected iPhone, choose your Personal Team under Signing & Capabilities, and change the bundle identifier to a unique name such as `com.yourname.inboxonly`. Build and run. A free Apple Account works for personal testing with the same seven-day restriction. This project does not require the paid Apple Developer Program for its basic functionality.

## What the app does

- Loads `https://www.instagram.com/direct/inbox/` directly.
- Permits Instagram message routes and a small set of login, password-reset and challenge routes.
- Checks both page navigation and server redirects. Blocks unsupported URLs, external links, app-opening schemes and new unfiltered windows.
- Injects a guard at document start for Instagram's in-page navigation, including history changes and link clicks. Blocked native-app attempts return to the inbox.
- Keeps a native cover over pages while loading; reveals the page only after the guard has initialized.
- Remembers the login using WebKit's local website store; Settings can clear it.
- Covers the web view when the app becomes inactive to reduce chat exposure in the app switcher.

The app does not read credentials, cookies or message text, and has no analytics/server. Instagram itself still receives and processes your account activity. JavaScript inspects navigation links and the current URL solely to apply filtering. Login/challenge subframes and ordinary media/network requests are not route-filtered because blocking them would break the website.

## Limits

- **No incoming-message push notifications.** Open the app to check messages. This project does not implement a message-reading backend.
- **No control over the installed Instagram app.** It cannot detect you tapping Reels in that app, terminate it, or selectively block its tabs.
- **No guaranteed calls, voice messages or feature parity.** Only features Instagram exposes to the mobile website can work; they still require testing here.
- **No Facebook login in this prototype.** Only the exact Instagram hosts are allowed for full-page navigation. New auth routes may need a small allowlist update.
- **Shared media can appear inside a chat.** Clicking into a Reel/post/profile is blocked, but previews and media embedded within conversations are not classified or removed.
- **External links are deliberately blocked too.** This is a strict inbox-only shell, not a general browser. Clicking a blocked link may reload the inbox and discard an unsent draft.
- Instagram may change its site, reject embedded-browser login, require checks, or expose an in-page route that needs a filter update. This is not an account-safety guarantee or a security boundary.
- A generic separate website/PWA cannot filter `instagram.com` in another tab. Browser isolation prevents that; use the extension or the native wrapper.

## Development and verification

Node 20+ is enough for local tests and bundling. No `npm install` or third-party JS dependency is needed.

```powershell
node --test tests/*.test.cjs
node scripts/build-userscript.mjs
node --check dist/InboxOnly.user.js
```

Edit `InboxOnly/Resources/navigation-rules.json` to maintain the allowlist. Both native Swift and injected JavaScript consume this file. Edit `guard.js` for browser behavior, then regenerate the Safari script. Avoid expanding the allowlist to the feed or general profile routes.

On macOS, compile the native application:

```sh
xcodebuild -project InboxOnly.xcodeproj -scheme InboxOnly \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath build/DerivedData \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY='' build
```

Before treating an on-device build as usable, check:

1. Fresh login, 2FA, saved-login prompt and reopening the app.
2. Existing thread, new conversation, group chat, requests, and photo attachment.
3. Feed, Reels, Explore, profile, story and shared-post links; confirm they cannot open outside messages.
4. Back/swipe gestures, long-press links, external links and “Open Instagram” prompts.
5. Offline load/retry and clearing local login.
6. Return from background and seven-day refresh preserving login.

The automated tests exercise URL decisions and a simulated browser environment. They do not prove current Instagram compatibility, WebKit behavior or successful iPhone installation.
