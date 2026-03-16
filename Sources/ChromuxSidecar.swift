// ChromuxSidecar.swift — Chromium/CDP sidecar process manager
//
// Manages the chromux TypeScript sidecar that provides a Chromium browser
// engine with full CDP access as an alternative to the default WKWebView.
//
// Architecture:
//   cmux app  ──►  ChromuxSidecar  ──► bun run src/chromux.ts start
//                  (this file)          (~/sandbox/chromux sidecar)
//
// The sidecar writes /tmp/chromux-state.json with {pid, cdpPort, cdpUrl, ...}
// and listens on /tmp/chromux-bridge.sock for browser.engine.* JSON commands.
//
// Design decisions:
//   - Additive: if engine = webkit (default), this code does nothing.
//   - Opt-in: set CMUX_BROWSER_ENGINE=chromium env var or UserDefaults key.
//   - Child process: sidecar is a child of cmux; SIGTERM on app quit cleans it up.
//   - No Xcode target changes needed: plain Swift file, no new SPM packages.

import Foundation
import Combine
import Bonsplit

// ─── Settings ────────────────────────────────────────────────────────────────

/// The active browser engine mode.
enum BrowserEngineMode: String, CaseIterable {
    /// Default: use WKWebView (existing behavior, unchanged)
    case webkit = "webkit"
    /// Opt-in: launch Chromium via the chromux sidecar for full CDP access
    case chromium = "chromium"
}

/// Persistent settings for BrowserEngine selection.
/// Follows the same pattern as `BrowserThemeSettings`.
enum BrowserEngineSettings {
    static let appStorageKey    = "browserEngineMode"
    static let headlessKey      = "browserEngineHeadless"
    static let envOverrideKey   = "CMUX_BROWSER_ENGINE"
    static let defaultMode: BrowserEngineMode = .webkit
    static let defaultHeadless: Bool = false   // visible window by default

    /// Resolve the effective engine mode, honoring env var override.
    static func effectiveMode(
        userMode: BrowserEngineMode? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        defaults: UserDefaults = .standard
    ) -> BrowserEngineMode {
        // Env var wins over everything (useful for CI / agent invocations)
        if let raw = environment[envOverrideKey], !raw.isEmpty,
           let mode = BrowserEngineMode(rawValue: raw.lowercased().trimmingCharacters(in: .whitespaces)) {
            return mode
        }
        // UserDefaults (app preference)
        let resolved = userMode ?? persistedMode(defaults: defaults)
        return resolved
    }

    static func persistedMode(defaults: UserDefaults = .standard) -> BrowserEngineMode {
        guard let raw = defaults.string(forKey: appStorageKey),
              let mode = BrowserEngineMode(rawValue: raw) else {
            return defaultMode
        }
        return mode
    }

    static func setMode(_ mode: BrowserEngineMode, defaults: UserDefaults = .standard) {
        defaults.set(mode.rawValue, forKey: appStorageKey)
    }

    static func isHeadless(defaults: UserDefaults = .standard) -> Bool {
        guard defaults.object(forKey: headlessKey) != nil else { return defaultHeadless }
        return defaults.bool(forKey: headlessKey)
    }

    static func setHeadless(_ headless: Bool, defaults: UserDefaults = .standard) {
        defaults.set(headless, forKey: headlessKey)
    }
}

// ─── State ────────────────────────────────────────────────────────────────────

/// The JSON payload chromux writes to /tmp/chromux-state.json.
struct ChromuxState: Decodable {
    let pid: Int32
    let cdpPort: Int
    let cdpUrl: String
    let profileDir: String
    let startedAt: String
    let headless: Bool
}

// ─── Sidecar manager ─────────────────────────────────────────────────────────

/// Manages the lifecycle of the chromux Bun/TypeScript sidecar process.
///
/// Usage:
///   let sidecar = ChromuxSidecar.shared
///   try await sidecar.start()        // launches bun run src/chromux.ts start
///   let url = sidecar.cdpUrl         // ws://127.0.0.1:<port>/devtools/browser/...
///   await sidecar.stop()             // SIGTERM → SIGKILL fallback
@MainActor
final class ChromuxSidecar: ObservableObject {
    static let shared = ChromuxSidecar()

    // Published state — SwiftUI views can observe these directly
    @Published private(set) var isRunning  = false
    @Published private(set) var isHeadless = BrowserEngineSettings.defaultHeadless
    @Published private(set) var cdpUrl: String? = nil
    @Published private(set) var cdpPort: Int? = nil
    @Published private(set) var chromePid: Int32? = nil
    @Published private(set) var lastError: String? = nil

    // Internal
    private var process: Process? = nil
    private var stateCheckTimer: DispatchSourceTimer? = nil

    private let statePath   = "/tmp/chromux-state.json"
    private let bridgePath  = "/tmp/chromux-bridge.sock"
    /// Resolved sidecar directory: prefer the bundled copy inside the app's Resources,
    /// fall back to ~/sandbox/chromux for development convenience.
    private let sidecarDir: String = {
        if let bundled = Bundle.main.resourceURL?
            .appendingPathComponent("chromux-sidecar").path,
           FileManager.default.fileExists(atPath: bundled + "/src/chromux.ts") {
            return bundled
        }
        return NSHomeDirectory() + "/sandbox/chromux"
    }()
    private let bunBinary   = NSHomeDirectory() + "/.bun/bin/bun"

    private init() {}

    // ── Public API ────────────────────────────────────────────────────────────

    /// Start the chromux sidecar.
    /// Idempotent — if already running, does nothing.
    func start() async throws {
        guard !isRunning else { return }
        guard validatePaths() else { return }

        lastError = nil
        dlog("chromux: starting sidecar from \(sidecarDir)")
        cleanupStaleFiles()
        // Brief pause to allow Chrome to fully exit after SIGTERM
        try await Task.sleep(nanoseconds: 500_000_000) // 0.5 s

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bunBinary)
        proc.arguments = ["run", "src/chromux.ts", "start"]
        proc.currentDirectoryURL = URL(fileURLWithPath: sidecarDir)
        proc.environment = inheritedEnvironment()

        // Silence sidecar stdout/stderr in release; pipe in debug for diagnostics.
        #if DEBUG
        proc.standardOutput = FileHandle.standardOutput
        proc.standardError  = FileHandle.standardError
        #else
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError  = FileHandle.nullDevice
        #endif

        proc.terminationHandler = { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.handleSidecarTermination()
            }
        }

        try proc.run()
        process = proc
        dlog("chromux: bun sidecar launched (PID \(proc.processIdentifier))")

        // Poll for the state file — chromux writes it once CDP is ready.
        // 20 s timeout: Chrome cold-start can take 5-8 s on a loaded machine.
        let state = try await waitForState(timeoutSeconds: 20)
        dlog("chromux: sidecar ready — Chrome PID \(state.pid), CDP port \(state.cdpPort)")
        applyState(state)
        startHealthTimer()
    }

    /// Stop the chromux sidecar gracefully.
    func stop() async {
        stopHealthTimer()

        if let proc = process, proc.isRunning {
            proc.terminate()
            // Give it 2 s to exit cleanly, then force-kill
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if proc.isRunning {
                proc.interrupt() // SIGKILL
            }
        }

        process = nil
        cleanupStaleFiles()
        clearPublishedState()
    }

    /// Return the CDP HTTP endpoint URL for use with Playwright/Puppeteer.
    /// e.g. "http://127.0.0.1:59500"
    var cdpHttpUrl: String? {
        guard let port = cdpPort else { return nil }
        return "http://127.0.0.1:\(port)"
    }

    /// Bridge socket path for browser.engine.* commands.
    var bridgeSocketPath: String { bridgePath }

    // ── Private helpers ───────────────────────────────────────────────────────

    private func validatePaths() -> Bool {
        let fm = FileManager.default

        guard fm.fileExists(atPath: bunBinary) else {
            lastError = "Bun not found at \(bunBinary). Install Bun: https://bun.sh"
            return false
        }

        let entrypoint = sidecarDir + "/src/chromux.ts"
        guard fm.fileExists(atPath: entrypoint) else {
            lastError = "chromux sidecar not found at \(entrypoint)."
            return false
        }

        let chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        guard fm.fileExists(atPath: chromePath) else {
            lastError = "Google Chrome not found at \(chromePath). Install Chrome first."
            return false
        }

        return true
    }

    private func cleanupStaleFiles() {
        // Kill by PID from state file if present
        if let staleState = readState() {
            kill(staleState.pid, SIGTERM)
            dlog("chromux: killed stale Chrome PID \(staleState.pid) before restart")
        }
        // Always pkill by profile dir — catches orphans that outlived the state file
        // (e.g. repeated reloads where stop() ran but Chrome kept the profile lock)
        killAllChromuxChrome()
        try? FileManager.default.removeItem(atPath: statePath)
        try? FileManager.default.removeItem(atPath: bridgePath)
    }

    /// Kill every Chrome/Chromium process using the chromux profile dir.
    /// Safe to call even if no such processes exist.
    private func killAllChromuxChrome() {
        let profileDir = NSHomeDirectory() + "/.chromux/profile"
        let pkill = Process()
        pkill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        pkill.arguments = ["-f", "user-data-dir=\(profileDir)"]
        pkill.standardOutput = FileHandle.nullDevice
        pkill.standardError  = FileHandle.nullDevice
        try? pkill.run()
        pkill.waitUntilExit()
    }

    private func waitForState(timeoutSeconds: TimeInterval) async throws -> ChromuxState {
        let deadline = Date().addingTimeInterval(timeoutSeconds)

        while Date() < deadline {
            if let state = readState() { return state }
            try await Task.sleep(nanoseconds: 200_000_000) // 0.2 s
        }

        throw ChromuxError.startupTimeout(timeoutSeconds: timeoutSeconds)
    }

    private func readState() -> ChromuxState? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: statePath)) else { return nil }
        return try? JSONDecoder().decode(ChromuxState.self, from: data)
    }

    private func applyState(_ state: ChromuxState) {
        isRunning  = true
        isHeadless = state.headless
        chromePid  = state.pid
        cdpPort    = state.cdpPort
        cdpUrl     = state.cdpUrl
        lastError  = nil
    }

    private func clearPublishedState() {
        isRunning  = false
        isHeadless = BrowserEngineSettings.defaultHeadless
        chromePid  = nil
        cdpPort    = nil
        cdpUrl     = nil
    }

    private func handleSidecarTermination() {
        isRunning  = false
        isHeadless = BrowserEngineSettings.defaultHeadless
        chromePid  = nil
        cdpPort    = nil
        cdpUrl     = nil
        process    = nil
        stopHealthTimer()
        cleanupStaleFiles()
    }

    // ── Health monitoring ─────────────────────────────────────────────────────

    /// Check every 5 s that Chrome is still alive (state file present + pid alive).
    private func startHealthTimer() {
        stopHealthTimer()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 5, repeating: 5, leeway: .seconds(1))
        timer.setEventHandler { [weak self] in
            Task { @MainActor [weak self] in
                self?.runHealthCheck()
            }
        }
        timer.resume()
        stateCheckTimer = timer
    }

    private func stopHealthTimer() {
        stateCheckTimer?.cancel()
        stateCheckTimer = nil
    }

    private func runHealthCheck() {
        guard isRunning else { return }

        guard let state = readState() else {
            // State file gone — Chrome crashed or sidecar exited
            isRunning = false
            cdpUrl    = nil
            cdpPort   = nil
            chromePid = nil
            lastError = "chromux process exited unexpectedly"
            return
        }

        // Refresh published state in case port rotated (unlikely but defensive)
        cdpPort   = state.cdpPort
        cdpUrl    = state.cdpUrl
        chromePid = state.pid
    }

    // ── Environment ───────────────────────────────────────────────────────────

    private func inheritedEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        // Force info-level logging from the sidecar
        env["CHROMUX_LOG"] = env["CHROMUX_LOG"] ?? "info"
        // Pass headless preference (1 = headless, 0 = visible window)
        let headless = BrowserEngineSettings.isHeadless()
        env["CHROMUX_HEADLESS"] = headless ? "1" : "0"
        // Ensure bun can find its runtime
        let path = env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"
        let bunDir = (bunBinary as NSString).deletingLastPathComponent
        env["PATH"] = "\(bunDir):\(path)"
        return env
    }
}

// ─── Errors ───────────────────────────────────────────────────────────────────

enum ChromuxError: LocalizedError {
    case startupTimeout(timeoutSeconds: TimeInterval)
    case binaryNotFound(path: String)

    var errorDescription: String? {
        switch self {
        case .startupTimeout(let s):
            return "chromux sidecar did not start within \(Int(s)) seconds."
        case .binaryNotFound(let p):
            return "Required binary not found: \(p)"
        }
    }
}
