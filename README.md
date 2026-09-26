# InboxOnly

A free personal project that opens Instagram messages and blocks navigation to the feed, Reels, Explore, posts, stories and profiles. It uses Instagram's real website, with your existing account and conversations. It is independent of Instagram, Meta and Konvo. No subscription, backend, private Instagram API or paid SDK.

**Interface:** the iPhone app shows **Instagram's own mobile messages page** inside a native app shell, the same way Konvo does ("because it is Instagram", in Konvo's words). No third-party app can show the official Instagram app's native DM screens. What InboxOnly controls is everything around the page, and version 1.1 makes that behave like an app rather than a browser tab (see below).

**Status: source prototype.** Version 1.0 built successfully in [GitHub Actions](https://github.com/cristian200504/InboxOnly/actions/runs/36266128768), and the user reported that it runs. Versions 1.0.1 and 1.1.0 have not been built or tested on an iPhone yet. Local route/DOM tests do not establish compatibility with every Instagram website version.

## What's new in 1.1

**Reels sent in a chat can't be watched.** Opening a Reel from a DM does not change the address: Instagram draws a full-screen player over the conversation, and swiping moves into suggested Reels. (This was measured on-device by the [insta-filter](https://github.com/blobspire/insta-filter) project.) Anything keyed to the URL, including the 1.0 filter, never sees it. InboxOnly now uses layered checks:

1. Tapping a link to a Reel, post or profile, or a recognisable Reel card, is swallowed and a short notice appears. The chat stays as it was. Only a finished *tap* is blocked, so a scroll that starts on a Reel card still scrolls. (1.0.1 blocked on touch-down, which would have thrown you out of the chat mid-scroll.)
2. If a player still opens, it is detected by what it is — a video covering the screen top to bottom, whatever its markup or language — then paused, hidden, and the same chat reloads. A video bubble inside a conversation never covers the screen, so it is left alone.
3. The native app also checks every address WebKit commits, including in-page history changes, and Instagram links in chats appear greyed out.

**It feels like an app.**

- The page runs edge to edge between the status bar and a native bottom bar. Both take the page's own background colour, light or dark.
- Tapping the message box no longer zooms the chat. Pinch zoom, the grey tap flash and the link/image pop-up menus are gone.
- The web "‹ › Done" bar above the keyboard is removed.
- Swipe from the left edge to go back from a chat to the inbox.
- Instagram's feed/Explore/Reels navigation and "open the app" links are hidden.
- The app has a real icon instead of a blank one.

**Camera and photos.** In an open chat, the bottom bar's **camera** button opens the iPhone camera and the **photo** button opens your library. The picture is handed to Instagram's own upload control in that chat, exactly as if you had picked it there, so Instagram sends it normally. Photos can only be sent once someone has accepted your message request; that is Instagram's rule. If Instagram's mobile page offers no upload control, the app says so instead of failing silently.

**View-once photos are not possible here.** Instagram's website cannot send view-once ("disappearing") photos or videos; that feature exists only in the official app. Both open-source DM-only projects this was checked against ([insta-filter](https://github.com/blobspire/insta-filter), [delaygram](https://github.com/arielcorte/delaygram)) list it as a mobile-web limitation. The only way around it would be imitating the Instagram app's private API. That is against Instagram's terms, risks your account being locked, and could not be tested here — a "view once" button that silently sent a permanent photo would be worse than none. The camera sends a normal photo that stays in the chat.

**Other 1.1 notes:** the "…" button in the bottom bar has Reload, About and Clear login. A video someone sends you may also close if Instagram opens it full screen, since it looks the same as a Reel player. If a shared Reel still plays, report whether it opened full screen and whether the page reloaded.

To install the update, commit the changed files in GitHub Desktop and **Push origin**, then run **Build unsigned iPhone app** on `main`. Download the successful run's new IPA and import it through **AltStore > My Apps > +** using the same Apple Account as before. Keep the existing app installed so AltStore updates it and keeps your login.

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

The workflow is manual, uses no signing credentials and uploads no account data. It produces an installable package only after a successful compile and subsequent local signing.

### If you get access to a Mac

Open the Xcode project, select your connected iPhone, choose your Personal Team under Signing & Capabilities, and change the bundle identifier to a unique name such as `com.yourname.inboxonly`. Build and run. A free Apple Account works for personal testing with the same seven-day restriction. This project does not require the paid Apple Developer Program for its basic functionality.

## What the app does

- Loads `https://www.instagram.com/direct/inbox/` directly.
- Permits Instagram message routes and a small set of login, password-reset and challenge routes.
- Checks both page navigation and server redirects. Blocks unsupported URLs, external links, app-opening schemes and new unfiltered windows.
- Injects a guard at document start for Instagram's in-page navigation, including history changes, link taps, recognized Reel preview cards, Reel dialogs and full-screen video players. A swallowed tap only shows a notice; anything that got as far as rendering reloads the chat you were in.
- Also checks every address WebKit commits, so an in-page route change the guard missed still gets caught.
- Keeps a native cover over pages while loading; reveals the page only after the guard has initialized.
- Native bottom bar: inbox, camera, photo library and a "…" menu (Reload, About, Clear login). Camera and photos are enabled only inside a chat.
- Remembers the login using WebKit's local website store; the "…" menu can clear it.
- Covers the web view when the app becomes inactive to reduce chat exposure in the app switcher.

The app does not read credentials, cookies or message text, and has no analytics/server. Instagram itself still receives and processes your account activity. JavaScript inspects navigation links, tapped elements, video sizes and the current URL solely to apply filtering. A photo you pick is resized on the phone and handed to Instagram's page; InboxOnly keeps no copy. Login/challenge subframes and ordinary media/network requests are not route-filtered because blocking them would break the website.

## Limits

- **No incoming-message push notifications.** Open the app to check messages. This project does not implement a message-reading backend.
- **No control over the installed Instagram app.** It cannot detect you tapping Reels in that app, terminate it, or selectively block its tabs.
- **No guaranteed calls, voice messages or feature parity.** Only features Instagram exposes to the mobile website can work; they still require testing here.
- **No view-once photos.** Instagram's website cannot send them (see "What's new in 1.1"). The camera button sends a normal photo.
- **No Facebook login in this prototype.** Only the exact Instagram hosts are allowed for full-page navigation. New auth routes may need a small allowlist update.
- **Shared media still appears inside a chat,** so you can see that something was sent. Reel links are greyed out and taps on them are swallowed; a player that opens anyway is closed. Ordinary photos stay usable. A video someone sends you may also close if Instagram shows it full screen.
- **External links are deliberately blocked too.** This is a strict inbox-only shell, not a general browser. A blocked tap leaves the chat alone; when something has to be closed, the chat reloads and an unsent draft can be lost.
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
2. Existing thread, new conversation, group chat, requests, and photo attachment through Instagram's own button, the bottom-bar camera and the bottom-bar photo library.
3. Feed, Reels, Explore, profile, story and shared-post links; test both ordinary links and the image/play area of a shared Reel card, including a player that opens full screen over the conversation. Confirm a scroll that starts on a Reel card still scrolls, and that normal photo and video attachments still work.
4. Back/swipe gestures, long-press links, external links and “Open Instagram” prompts.
5. Typing: no zoom when the message box is focused and no "‹ › Done" bar above the keyboard. Light and dark Instagram themes colour the status bar and bottom bar to match.
6. Offline load/retry and clearing local login.
7. Return from background and seven-day refresh preserving login.

The automated tests exercise URL decisions and a simulated browser environment. They do not prove current Instagram compatibility, WebKit behavior or successful iPhone installation.
