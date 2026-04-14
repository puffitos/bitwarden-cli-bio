import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { logDebug, logVerbose } from "../log";

/**
 * Platform-specific IPC socket service for connecting to the Bitwarden desktop app.
 *
 * The desktop app listens on a Unix domain socket (macOS/Linux) or named pipe (Windows).
 * In WSL2, the Desktop app runs on the Windows host and is only accessible via a socat bridge.
 * This service provides a platform-agnostic way to connect and communicate with it.
 */
export class IpcSocketService {
  private socket: net.Socket | null = null;
  private messageBuffer: Buffer = Buffer.alloc(0);
  private messageHandler: ((message: unknown) => void) | null = null;
  private disconnectHandler: (() => void) | null = null;

  /**
   * Get all socket candidates for the current platform in lookup order.
   */
  getSocketCandidates(): string[] {
    if (process.env.BWBIO_IPC_SOCKET_PATH) {
      return [process.env.BWBIO_IPC_SOCKET_PATH];
    }

    const platform = os.platform();

    if (platform === "win32") {
      return [this.getWindowsSocketPath()];
    }

    if (platform === "darwin") {
      return this.getMacSocketPaths();
    }

    if (this.isWSL()) {
      return this.getWslSocketPaths();
    }

    // Linux: use XDG cache directory or fallback
    return [this.getLinuxSocketPath()];
  }

  /**
   * Detect whether we are running inside WSL (Windows Subsystem for Linux).
   */
  isWSL(): boolean {
    try {
      const osrelease = fs.readFileSync("/proc/sys/kernel/osrelease", "utf8");
      return /microsoft/i.test(osrelease);
    } catch {
      return false;
    }
  }

  /**
   * Detect whether we are running inside WSL2 specifically (as opposed to WSL1).
   */
  isWSL2(): boolean {
    try {
      const osrelease = fs.readFileSync("/proc/sys/kernel/osrelease", "utf8");
      return /WSL2/i.test(osrelease);
    } catch {
      return false;
    }
  }

  /**
   * Get socket candidates when running inside WSL.
   *
   * The Bitwarden Desktop app runs on Windows, so WSL needs to reach the Windows-side IPC:
   * - WSL1: can access Windows named pipes directly (syscall translation layer)
   * - WSL2: runs in a VM and cannot access named pipes; requires a socat bridge
   *
   * Bridge setup (WSL2 only):
   *   npiperelay.exe must be installed on Windows.
   *   Run once per session (e.g. in ~/.bashrc or ~/.profile):
   *
   *   PIPE=$(node -e "const c=require('crypto'),h=c.createHash('sha256').update(process.env.USERPROFILE||'').digest().toString('base64').replace(/\\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');console.log(h+'.s.bw')")
   *   rm -f $XDG_RUNTIME_DIR/bwbio-bridge.sock
   *   socat UNIX-LISTEN:$XDG_RUNTIME_DIR/bwbio-bridge.sock,fork EXEC:"npiperelay.exe -ei -s //./pipe/$PIPE",nofork &
   */
  private getWslSocketPaths(): string[] {
    const candidates: string[] = [];

    if (!this.isWSL2()) {
      // WSL1: direct named pipe access may work
      const winPipePath = this.getWindowsNamedPipeForWSL();
      if (winPipePath) {
        candidates.push(winPipePath);
      }
    }

    // WSL2 (and WSL1 fallback): try the socat bridge socket
    candidates.push(...this.getWslBridgeSocketPaths());

    // Last resort: native Linux Desktop app socket (if running Bitwarden Desktop inside WSL)
    candidates.push(this.getLinuxSocketPath());

    return candidates;
  }

  /**
   * Compute the Windows named pipe path using the Windows home directory.
   * Only works reliably in WSL1 where named pipes are accessible.
   */
  private getWindowsNamedPipeForWSL(): string | null {
    const winHome = this.getWindowsHomeDir();
    if (!winHome) {
      return null;
    }
    const hash = crypto.createHash("sha256").update(winHome).digest();
    const hashB64 = hash
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `\\\\.\\pipe\\${hashB64}.s.bw`;
  }

  /**
   * Determine the Windows home directory path (in Windows format, e.g. C:\Users\username).
   *
   * Tries, in order:
   * 1. USERPROFILE env var (set automatically in interactive WSL sessions from Windows Terminal)
   * 2. Scan /mnt/c/Users/ for a directory that matches the WSL username or is the only non-system entry
   */
  getWindowsHomeDir(): string | null {
    // 1. USERPROFILE is the most reliable source (e.g. C:\Users\username)
    const userProfile = process.env.USERPROFILE;
    if (userProfile) {
      return userProfile;
    }

    // 2. Scan /mnt/c/Users/ for plausible home directories
    const usersDir = "/mnt/c/Users";
    try {
      const systemDirs = new Set([
        "All Users",
        "Default",
        "Default User",
        "Public",
        "desktop.ini",
      ]);
      const entries = fs
        .readdirSync(usersDir)
        .filter((e) => !systemDirs.has(e));

      if (entries.length === 0) {
        return null;
      }

      // Prefer an entry matching the current WSL username
      const wslUser = os.userInfo().username;
      const match = entries.find(
        (e) => e.toLowerCase() === wslUser.toLowerCase(),
      );
      const chosen = match ?? entries[0];

      logVerbose(
        `USERPROFILE not set; using /mnt/c/Users/${chosen} as Windows home dir`,
      );

      // Return in Windows backslash format to match what Bitwarden Desktop hashes
      return `C:\\Users\\${chosen}`;
    } catch {
      return null;
    }
  }

  /**
   * Get the socat bridge socket paths for WSL2.
   * The user must run a socat+npiperelay bridge before using bwbio.
   */
  private getWslBridgeSocketPaths(): string[] {
    const candidates: string[] = [];

    // Primary: $XDG_RUNTIME_DIR/bwbio-bridge.sock (preferred, per-session)
    const runtimeDir = process.env.XDG_RUNTIME_DIR;
    if (runtimeDir) {
      candidates.push(path.join(runtimeDir, "bwbio-bridge.sock"));
    }

    // Fallback: ~/.cache/bwbio/bw-bridge.sock
    const cacheDir =
      process.env.XDG_CACHE_HOME != null
        ? process.env.XDG_CACHE_HOME
        : path.join(os.homedir(), ".cache");
    candidates.push(path.join(cacheDir, "bwbio", "bw-bridge.sock"));

    return candidates;
  }

  /**
   * Windows named pipe path - uses hash of home directory.
   */
  private getWindowsSocketPath(): string {
    const homeDir = os.homedir();
    const hash = crypto.createHash("sha256").update(homeDir).digest();
    // Use URL-safe base64 without padding (like Rust's URL_SAFE_NO_PAD)
    const hashB64 = hash
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `\\\\.\\pipe\\${hashB64}.s.bw`;
  }

  /**
   * Get the socket path on macOS.
   * The Desktop app can be sandboxed (Mac App Store) or non-sandboxed.
   */
  private getMacSocketPaths(): string[] {
    const homeDir = os.homedir();

    // Path for sandboxed Desktop app (Mac App Store version)
    const sandboxedPath = path.join(
      homeDir,
      "Library",
      "Group Containers",
      "LTZ2PFU5D6.com.bitwarden.desktop",
      "s.bw",
    );

    // Path for non-sandboxed Desktop app
    const nonSandboxedPath = path.join(
      homeDir,
      "Library",
      "Caches",
      "com.bitwarden.desktop",
      "s.bw",
    );

    return [sandboxedPath, nonSandboxedPath];
  }

  /**
   * Linux socket path - uses XDG_CACHE_HOME or ~/.cache.
   * Used when Bitwarden Desktop is running natively on Linux (not WSL).
   */
  private getLinuxSocketPath(): string {
    const cacheDir =
      process.env.XDG_CACHE_HOME != null
        ? process.env.XDG_CACHE_HOME
        : path.join(os.homedir(), ".cache");
    return path.join(cacheDir, "com.bitwarden.desktop", "s.bw");
  }

  /**
   * Connect to the desktop app's IPC socket.
   */
  async connect(): Promise<void> {
    if (this.socket != null) {
      logDebug("connect() called while already connected");
      return;
    }

    const socketPaths = this.getSocketCandidates();
    for (const socketPath of socketPaths) {
      logVerbose(`Connecting to desktop app (via ${socketPath})`);
      try {
        await this.connectToSocketPath(socketPath);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logVerbose(`Failed to connect: ${message}`);
      }
    }

    if (this.isWSL2()) {
      throw new Error(
        "Failed to connect to desktop app from WSL2. " +
          "The Bitwarden Desktop app runs on Windows and its IPC socket is not directly accessible from WSL2. " +
          "You need to set up a socat+npiperelay bridge. " +
          "See the WSL section in the README for setup instructions.",
      );
    }

    throw new Error(
      'Failed to connect to desktop app. Ensure the app is running and "Allow browser integration" is enabled in Desktop settings.',
    );
  }

  /**
   * Connect to a specific desktop app IPC socket path.
   */
  private async connectToSocketPath(socketPath: string): Promise<void> {
    logDebug(`Connecting to socket: ${socketPath}`);

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);

      socket.on("connect", () => {
        logDebug(`Socket connected: ${socketPath}`);
        this.socket = socket;
        resolve();
      });

      socket.on("data", (data: Buffer) => {
        logDebug(`Received raw data: ${data.length} bytes`);
        this.processIncomingData(data);
      });

      socket.on("error", (err) => {
        logDebug(
          `Socket error on ${socketPath}: ${err.message} (connected=${this.socket != null})`,
        );
        if (this.socket == null) {
          reject(err);
        }
      });

      socket.on("close", (hadError) => {
        logDebug(`Socket closed: ${socketPath} (hadError=${hadError})`);
        this.socket = null;
        this.messageBuffer = Buffer.alloc(0);
        if (this.disconnectHandler) {
          this.disconnectHandler();
        }
      });

      // Timeout for initial connection
      socket.setTimeout(5000, () => {
        if (this.socket == null) {
          logDebug(`Connection timeout for socket: ${socketPath}`);
          socket.destroy();
          reject(new Error("Connection to desktop app timed out"));
        } else {
          logDebug(`Socket timeout ignored (already connected): ${socketPath}`);
        }
      });
    });
  }

  /**
   * Disconnect from the socket.
   */
  disconnect(): void {
    if (this.socket != null) {
      logDebug("Disconnecting socket");
      this.socket.destroy();
      this.socket = null;
    }
    this.messageBuffer = Buffer.alloc(0);
  }

  /**
   * Set the handler for incoming messages.
   */
  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Set the handler for disconnect events.
   */
  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  /**
   * Send a message to the desktop app.
   * Uses length-delimited protocol: 4-byte little-endian length prefix + JSON payload.
   */
  sendMessage(message: unknown): void {
    if (this.socket == null || this.socket.destroyed) {
      throw new Error("Not connected to desktop app");
    }

    const messageStr = JSON.stringify(message);
    const messageBytes = Buffer.from(messageStr, "utf8");

    // Create buffer with 4-byte length prefix (little-endian)
    const buffer = Buffer.alloc(4 + messageBytes.length);
    buffer.writeUInt32LE(messageBytes.length, 0);
    messageBytes.copy(buffer, 4);

    logDebug(
      `Sending ${buffer.length} bytes (message: ${messageBytes.length} bytes)`,
    );

    this.socket.write(buffer);
  }

  /**
   * Process incoming data from the socket.
   * Messages are length-delimited: 4-byte LE length + JSON payload.
   */
  private processIncomingData(data: Buffer): void {
    this.messageBuffer = Buffer.concat([this.messageBuffer, data]);

    // Process all complete messages in the buffer
    while (this.messageBuffer.length >= 4) {
      const messageLength = this.messageBuffer.readUInt32LE(0);

      // Check if we have the full message
      if (this.messageBuffer.length < 4 + messageLength) {
        logDebug(
          `Waiting for more data: need ${4 + messageLength}, have ${this.messageBuffer.length}`,
        );
        break;
      }

      // Extract and parse the message
      const messageBytes = this.messageBuffer.subarray(4, 4 + messageLength);
      const messageStr = messageBytes.toString("utf8");

      // Update buffer to remove processed message
      this.messageBuffer = this.messageBuffer.subarray(4 + messageLength);

      try {
        const message = JSON.parse(messageStr);
        if (this.messageHandler) {
          this.messageHandler(message);
        } else {
          logDebug("Dropped message because no message handler is set");
        }
      } catch {
        logDebug("Failed to parse incoming IPC message as JSON");
      }
    }
  }
}
