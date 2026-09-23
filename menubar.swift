// Adobe MCP — menu bar wrapper.
//
// Runs hub.js as a child process and puts an icon in the menu bar, so the
// control panel is always one click away and quitting is obvious. Without this
// the app is invisible once you close its browser tab.

import Cocoa
import WebKit
import ApplicationServices

let dashboardURL = URL(string: "http://localhost:3001")!

/// The control panel, hosted in the app rather than a browser tab.
///
/// It is the same page the hub serves; this just gives it a real window, so
/// the settings for an app do not live in a stray Safari tab the user has to
/// keep track of. The browser remains available from the menu as a fallback.
final class ControlWindow: NSWindowController, NSWindowDelegate {
    private var web: WKWebView!

    convenience init(url: URL) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Moskito Easy MCP"
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("MoskitoEasyMCPControl")
        self.init(window: window)

        let config = WKWebViewConfiguration()
        web = WKWebView(frame: window.contentView!.bounds, configuration: config)
        web.autoresizingMask = [.width, .height]
        web.setValue(false, forKey: "drawsBackground")
        window.contentView?.addSubview(web)
        window.delegate = self
        web.load(URLRequest(url: url))
    }

    func reload() { web.reload() }

    func present() {
        // Become a normal app for as long as the window is up: a Dock icon, a
        // menu bar, cmd-tab. As an accessory the window stayed open when you
        // clicked away, but there was no way back to it — no Dock icon, not in
        // cmd-tab — so it read as having closed itself.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }

    // Closing puts it away rather than tearing it down, so reopening is instant
    // and the page keeps its scroll position.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        // Back to living in the menu bar only, so a background service does not
        // keep a Dock icon for a window that is not there.
        NSApp.setActivationPolicy(.accessory)
        return false
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var control: ControlWindow?
    var item: NSStatusItem!
    var hub: Process?

    func applicationDidFinishLaunching(_ note: Notification) {
        startHub()

        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        setIcon()

        let menu = NSMenu()
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        let header = NSMenuItem(title: "Moskito Easy MCP \(version)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Open Control Panel",
                                action: #selector(openPanel), keyEquivalent: "o"))
        menu.addItem(.separator())
        // The log is the app's only diagnostic and was named nowhere in the UI.
        menu.addItem(NSMenuItem(title: "Open in Browser",
                                action: #selector(openPanelInBrowser), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Open Log", action: #selector(openLog), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Restart Background Service",
                                action: #selector(restartHub), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Moskito Easy MCP",
                                action: #selector(quit), keyEquivalent: "q"))
        item.menu = menu

        launched = true
        watchForShowRequests()
        watchForArrangeRequests()

        // First run: show the panel so setup isn't hidden behind the menu bar.
        if !UserDefaults.standard.bool(forKey: "hasLaunched") {
            UserDefaults.standard.set(true, forKey: "hasLaunched")
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { self.openPanel() }
        }
    }

    var quitting = false
    var restarts = 0
    var gaveUp = false
    var launched = false
    var lastStart = Date.distantPast

    func startHub() {
        guard let res = Bundle.main.resourcePath else { return }
        let log = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/AdobeMCP.log")
        // Appending, not truncating: createFile() here wiped the log on every
        // start, so a crash loop destroyed the record of what crashed.
        if !FileManager.default.fileExists(atPath: log.path) {
            FileManager.default.createFile(atPath: log.path, contents: nil)
        }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: res + "/runtime/node")
        p.arguments = [res + "/hub.js"]
        // The hub quits itself if it is orphaned, but only when we started it:
        // the no-swiftc fallback launcher would otherwise trip that instantly.
        var env = ProcessInfo.processInfo.environment
        env["ADOBE_MCP_SUPERVISED"] = "1"
        p.environment = env
        if let handle = try? FileHandle(forWritingTo: log) {
            handle.seekToEndOfFile()
            p.standardOutput = handle
            p.standardError = handle
        }
        // If the hub dies the menu bar icon would still be there doing nothing,
        // so bring it back — with a pause, so a crash loop doesn't spin.
        // Restart a hub that dies — but a hub that dies instantly is broken, and
        // relaunching it forever just fills the log. Give up after a few tries.
        p.terminationHandler = { [weak self] _ in
            guard let self, !self.quitting else { return }
            DispatchQueue.main.async {
                if Date().timeIntervalSince(self.lastStart) > 60 { self.restarts = 0 }
                self.restarts += 1
                guard self.restarts <= 5 else {
                    NSLog("Moskito Easy MCP: hub keeps crashing, giving up. See ~/Library/Logs/AdobeMCP.log")
                    self.gaveUp = true
                    // Make it visible: an icon that silently does nothing is worse
                    // than an icon that says something is wrong.
                    self.setIcon(alert: true)
                    let alert = NSAlert()
                    alert.messageText = "Moskito Easy MCP stopped working"
                    alert.informativeText = "Its background service failed to start five times. "
                        + "Open the log to see why, or use Restart Background Service to try again."
                    alert.addButton(withTitle: "Open Log")
                    alert.addButton(withTitle: "Later")
                    if alert.runModal() == .alertFirstButtonReturn { self.openLog() }
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    self.startHub()
                    // Give the hub a moment, then refresh the page it serves.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.control?.reload() }
                }
            }
        }
        lastStart = Date()
        try? p.run()
        hub = p
    }

    @objc func openPanel() {
        if control == nil { control = ControlWindow(url: dashboardURL) }
        control?.present()
    }

    @objc func openPanelInBrowser() {
        NSWorkspace.shared.open(dashboardURL)
    }

    // Double-clicking the app while it is already running should show the panel
    // rather than do nothing.
    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        openPanel()
        return true
    }

    /// Raised when the hub reopens us — which is what the ⚙ in an Adobe panel
    /// and "Open Control Panel" both end up doing.
    ///
    /// The first version tested `control?.window?.isVisible == false`, but
    /// `control` is nil until the window has been built once, and nil == false
    /// is false, so the very first request did nothing at all.
    func applicationDidBecomeActive(_ note: Notification) {
        guard launched else { return }   // don't fight the first-run sequence
        // Only while we are an accessory. Once the window is up we are a normal
        // app, and re-opening on every activation would fight a window the user
        // had just closed.
        guard NSApp.activationPolicy() == .accessory else { return }
        if control == nil || control?.window?.isVisible != true { openPanel() }
    }

    /// The Adobe panels' ⚙ asks the hub to raise this window; the hub writes a
    /// flag file and we watch it. Deliberately dull: `open -b` and an
    /// AppleScript activate both failed to reach an accessory app's reopen
    /// handler, and failed quietly, which is the worst combination.
    func watchForShowRequests() {
        let flag = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/AdobeMCP/show-window")
        // The baseline is taken ONCE, here, not inside the tick. Reading it in
        // the tick meant the first change after a missing file was swallowed as
        // the baseline, so the first request never opened anything.
        var lastSeen = (try? String(contentsOf: flag, encoding: .utf8)) ?? ""
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            guard let stamp = try? String(contentsOf: flag, encoding: .utf8) else { return }
            guard stamp != lastSeen else { return }
            lastSeen = stamp
            DispatchQueue.main.async { self.openPanel() }
        }
    }

    /* ------------------------------------------------------ arranging -- */

    /// Put the Adobe app on the left 80% of the screen and the AI assistants on
    /// the right 20%.
    ///
    /// This has to happen HERE, in the app itself, and not in the hub or a
    /// script it spawns. Moving another application's windows needs
    /// Accessibility permission, and macOS grants that to the process that
    /// asks — so the earlier osascript version made `osascript` the subject of
    /// the permission, not Moskito Easy MCP. The grant either never appeared or
    /// attached to the wrong app, and the call did nothing, silently. This
    /// binary carries the app's own signed identity, so the grant lands on
    /// Moskito Easy MCP and sticks across updates.
    func watchForArrangeRequests() {
        let req = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/AdobeMCP/arrange-request")
        var lastSeen = (try? String(contentsOf: req, encoding: .utf8)) ?? ""
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            guard let body = try? String(contentsOf: req, encoding: .utf8) else { return }
            guard body != lastSeen else { return }
            lastSeen = body
            // stamp, split, adobe .app, then any assistant .apps installed.
            let parts = body.split(separator: "\n").map(String.init)
            guard parts.count >= 3, let split = Double(parts[1]) else { return }
            DispatchQueue.main.async {
                self.arrange(adobe: parts[2], assistants: Array(parts.dropFirst(3)), split: split)
            }
        }
    }

    private func arrangeResult(_ text: String) {
        let out = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/AdobeMCP/arrange-result")
        try? text.write(to: out, atomically: true, encoding: .utf8)
    }

    func arrange(adobe: String, assistants: [String], split: Double) {
        // Prompts the first time, then never again — the answer is remembered
        // against this app's signature.
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
        guard AXIsProcessTrustedWithOptions(opts as CFDictionary) else {
            arrangeResult("needs-permission")
            return
        }

        guard let screen = NSScreen.main else { return arrangeResult("no screen") }
        // visibleFrame, not frame: it already excludes the menu bar and the
        // Dock, so nothing ends up underneath them.
        let area = screen.visibleFrame
        let wide = (area.width * CGFloat(split)).rounded()

        let left = NSRect(x: area.minX, y: area.minY, width: wide, height: area.height)
        // Every running assistant goes to the same right-hand column. Splitting
        // the remainder again between two of them leaves neither usable;
        // whichever you bring forward fills it.
        let right = NSRect(x: area.minX + wide, y: area.minY,
                           width: area.width - wide, height: area.height)
        let jobs = [(adobe, left)] + assistants.map { ($0, right) }

        // A window that is zoomed or full-screen keeps that state after an AX
        // resize, and AppKit puts the old frame back the moment the app is
        // activated again — so the arrangement looked fine until you clicked on
        // Illustrator. Clear the state first. Leaving full screen is animated,
        // so the move has to wait for it to finish.
        var animating = false
        for (p, _) in jobs where unmaximize(bundlePath: p) { animating = true }

        DispatchQueue.main.asyncAfter(deadline: .now() + (animating ? 1.0 : 0)) {
            guard self.place(bundlePath: adobe, to: left) else {
                return self.arrangeResult("no window to move \u{2014} is it open?")
            }
            for (p, frame) in jobs.dropFirst() { _ = self.place(bundlePath: p, to: frame) }
            self.arrangeResult("ok")
        }
    }

    /// The window we should be moving: the main one, else the first.
    ///
    /// An Adobe app has its palettes and panels in this list too, and resizing
    /// a palette to 80% of the screen would be a memorable bug.
    private func mainWindow(bundlePath: String) -> AXUIElement? {
        guard let id = Bundle(path: bundlePath)?.bundleIdentifier,
              let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first
        else { return nil }

        let ax = AXUIElementCreateApplication(app.processIdentifier)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement], !windows.isEmpty
        else { return nil }

        return windows.first { w in
            var main: CFTypeRef?
            AXUIElementCopyAttributeValue(w, kAXMainAttribute as CFString, &main)
            return (main as? Bool) == true
        } ?? windows[0]
    }

    /// Take a window out of full screen or zoom, so our frame is the one it
    /// keeps. Returns true if it left full screen, which is animated.
    @discardableResult
    private func unmaximize(bundlePath: String) -> Bool {
        guard let w = mainWindow(bundlePath: bundlePath) else { return false }

        func isSet(_ attr: String) -> Bool {
            var v: CFTypeRef?
            AXUIElementCopyAttributeValue(w, attr as CFString, &v)
            return (v as? Bool) == true
        }

        // AXFullScreen is not in the kAX* constants but every AppKit window
        // that has a green button exposes it.
        var wasFullScreen = false
        if isSet("AXFullScreen") {
            AXUIElementSetAttributeValue(w, "AXFullScreen" as CFString, kCFBooleanFalse)
            wasFullScreen = true
        }
        // Likewise AXZoomed: it has no Swift constant, only the string.
        if isSet("AXZoomed") {
            AXUIElementSetAttributeValue(w, "AXZoomed" as CFString, kCFBooleanFalse)
        }
        return wasFullScreen
    }

    /// Move and resize an application's main window.
    private func place(bundlePath: String, to frame: NSRect) -> Bool {
        guard let target = mainWindow(bundlePath: bundlePath) else { return false }

        // AX measures from the top-left of the PRIMARY screen downwards;
        // NSScreen measures from the bottom-left upwards.
        let top = NSScreen.screens.first?.frame.maxY ?? frame.maxY
        var origin = CGPoint(x: frame.minX, y: top - frame.maxY)
        var size = CGSize(width: frame.width, height: frame.height)

        let posOK = AXUIElementSetAttributeValue(
            target, kAXPositionAttribute as CFString,
            AXValueCreate(.cgPoint, &origin)!) == .success
        let sizeOK = AXUIElementSetAttributeValue(
            target, kAXSizeAttribute as CFString,
            AXValueCreate(.cgSize, &size)!) == .success
        return posOK && sizeOK
    }

    /// The menu bar item's icon.
    ///
    /// Drawn in code rather than loaded from the bundle so it can never end up
    /// with no image AND no title — which is what the previous version risked:
    /// it relied on an SF Symbol, and if that name were unavailable the button
    /// would have been an invisible, unclickable gap in the menu bar. The
    /// fallback below guarantees something is always there.
    func setIcon(alert: Bool = false) {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { rect in
            // A template image carries only ALPHA — macOS tints every opaque
            // pixel to suit the menu bar. Painting black then white therefore
            // produced one solid blob; the mark has to be built out of holes.
            //
            // The EYE reads as: ground, eye, pupil. In alpha that is:
            //   fill the rounded square, punch the eye OUT, put the pupil back.
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: 4.2, yRadius: 4.2).fill()

            let eye = NSBezierPath(ovalIn: NSRect(x: rect.width * 0.165, y: rect.height * 0.165,
                                                  width: rect.width * 0.67, height: rect.height * 0.67))
            NSGraphicsContext.current?.compositingOperation = .destinationOut
            eye.fill()

            NSGraphicsContext.current?.compositingOperation = .sourceOver
            let pupil = NSBezierPath(ovalIn: NSRect(x: rect.width * 0.35, y: rect.height * 0.215,
                                                    width: rect.width * 0.30, height: rect.height * 0.30))
            NSColor.black.setFill()
            pupil.fill()
            return true
        }
        image.isTemplate = true
        item.button?.image = image
        item.button?.toolTip = alert ? "Moskito Easy MCP — stopped" : "Moskito Easy MCP"
        if item.button?.image == nil { item.button?.title = "MCP" }
        item.button?.appearsDisabled = alert
    }

    @objc func openLog() {
        let log = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/AdobeMCP.log")
        NSWorkspace.shared.open(log)
    }

    @objc func restartHub() {
        restarts = 0
        gaveUp = false
        setIcon()
        hub?.terminate()          // terminationHandler brings it back
        if hub == nil { startHub() }
    }

    @objc func quit() {
        NSApp.terminate(nil)
    }

    // The hub holds port 3001; leaving it running after a quit would block the
    // next launch and keep the Adobe panels talking to a ghost.
    func applicationWillTerminate(_ note: Notification) {
        quitting = true
        hub?.terminate()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
