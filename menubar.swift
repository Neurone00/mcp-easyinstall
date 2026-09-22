// Adobe MCP — menu bar wrapper.
//
// Runs hub.js as a child process and puts an icon in the menu bar, so the
// control panel is always one click away and quitting is obvious. Without this
// the app is invisible once you close its browser tab.

import Cocoa

let dashboardURL = URL(string: "http://localhost:3001")!

final class AppDelegate: NSObject, NSApplicationDelegate {
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
        menu.addItem(NSMenuItem(title: "Open Log", action: #selector(openLog), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Restart Background Service",
                                action: #selector(restartHub), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Moskito Easy MCP",
                                action: #selector(quit), keyEquivalent: "q"))
        item.menu = menu

        // First run: show the panel so setup isn't hidden behind the menu bar.
        if !UserDefaults.standard.bool(forKey: "hasLaunched") {
            UserDefaults.standard.set(true, forKey: "hasLaunched")
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { self.openPanel() }
        }
    }

    var quitting = false
    var restarts = 0
    var gaveUp = false
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
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.startHub() }
            }
        }
        lastStart = Date()
        try? p.run()
        hub = p
    }

    @objc func openPanel() {
        NSWorkspace.shared.open(dashboardURL)
    }

    // Double-clicking the app while it is already running should show the panel
    // rather than do nothing.
    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        openPanel()
        return true
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
            // The EYE mark: ground, white compound eye, punched-out pupil.
            // Template mode recolours it to suit light or dark menu bars.
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4).fill()

            let eye = NSBezierPath(ovalIn: NSRect(x: rect.width * 0.17, y: rect.height * 0.17,
                                                  width: rect.width * 0.66, height: rect.height * 0.66))
            NSColor.white.setFill()
            eye.fill()

            let pupil = NSBezierPath(ovalIn: NSRect(x: rect.width * 0.34, y: rect.height * 0.22,
                                                    width: rect.width * 0.30, height: rect.height * 0.30))
            NSColor.black.setFill()
            NSGraphicsContext.current?.compositingOperation = .destinationOut
            pupil.fill()
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            return true
        }
        image.isTemplate = true
        item.button?.image = image
        item.button?.toolTip = alert ? "Moskito Easy MCP — stopped" : "Moskito Easy MCP"
        // Belt and braces: if the image ever fails to draw, a short title keeps
        // the item visible and clickable instead of vanishing.
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
