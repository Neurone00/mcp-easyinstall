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
        item.button?.image = NSImage(systemSymbolName: "wand.and.rays",
                                     accessibilityDescription: "Adobe MCP")
        item.button?.image?.isTemplate = true

        let menu = NSMenu()
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        let header = NSMenuItem(title: "Adobe MCP \(version)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Open Control Panel",
                                action: #selector(openPanel), keyEquivalent: "o"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Adobe MCP",
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
    var lastStart = Date.distantPast

    func startHub() {
        guard let res = Bundle.main.resourcePath else { return }
        let log = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/AdobeMCP.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)

        let p = Process()
        p.executableURL = URL(fileURLWithPath: res + "/runtime/node")
        p.arguments = [res + "/hub.js"]
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
                    NSLog("Adobe MCP: hub keeps crashing, giving up. See ~/Library/Logs/AdobeMCP.log")
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
