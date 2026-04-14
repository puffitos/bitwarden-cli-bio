# bitwarden-cli-bio

Unlock your Bitwarden CLI vault with biometrics (Touch ID, Windows Hello, Linux Polkit) instead of typing your master password. Again. And again.

```bash
# before: ugh
bw get password github
? Master password: [type your 30-character password]

# after: nice
bwbio get password github
# [Touch ID prompt] → done
```

![demo](assets/demo.gif)

## How?

`bwbio` talks to the Bitwarden Desktop app over IPC — the same protocol the browser extension uses — to unlock your vault with biometrics. Then it hands off to the official `bw` CLI with the session key. You still need `bw` installed; `bwbio` just handles the unlock part.

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│                 │         │    Bitwarden    │         │   Touch ID /    │
│      bwbio      │   IPC   │    Desktop      │  System │  Windows Hello  │
│                 │ ◄─────► │    App          │ ◄─────► │  Linux Polkit   │
└─────────────────┘         └─────────────────┘         └─────────────────┘
        │
        │ delegates (with BW_SESSION)
        ▼
┌─────────────────┐
│   Official bw   │
│      CLI        │
└─────────────────┘
```

If biometrics fail for any reason (Desktop app closed, prompt cancelled, etc.), it falls back to the regular password prompt. It never blocks you.

## Setup

**You'll need:**
- Bitwarden Desktop app with biometrics enabled + "Allow browser integration" on
- Node.js >= 22
- Official `bw` CLI in your PATH

**Install:**

```bash
# With Homebrew (macOS/Linux)
brew install jeanregisser/tap/bitwarden-cli-bio

# Or with npm
npm install -g bitwarden-cli-bio
```

## Usage

```bash
# The magic: alias it and forget about it
alias bw=bwbio
bw get password github        # Touch ID, done
bw list items --search email  # still Touch ID, still done

# Or use it directly
bwbio get password github

# For scripts — get a session key
export BW_SESSION=$(bwbio unlock --raw)
```

If `BW_SESSION` is already set, `bwbio` skips biometrics and passes commands straight to `bw` (except `unlock`, which always attempts biometrics).

### Commands that skip biometrics

Some commands don't need an unlocked vault and go directly to `bw`:

```
login, logout, lock, config, update, completion, status, serve
--help / -h, --version / -v
```

Everything else triggers biometric unlock if the vault is locked.

`bwbio` also adds `--bwbio-version` to show the wrapper's own version (`--version` is passed through to `bw`).

## Environment variables

| Variable | Description |
|----------|-------------|
| `BW_SESSION` | Already set? `bwbio` skips biometrics and passes through to `bw` (except `unlock`) |
| `BW_QUIET` | Set to `true` to suppress all biometric-related messages |
| `BW_NOINTERACTION` | Set to `true` to skip biometric unlock (requires user interaction) |
| `BWBIO_VERBOSE` | Set to `true` for verbose logging |
| `BWBIO_DEBUG` | Set to `true` for raw IPC message dumps |
| `BWBIO_IPC_SOCKET_PATH` | Override the IPC socket path (advanced) |

## Troubleshooting

### `Failed to connect to desktop app from WSL2`

`bwbio` detected it is running in WSL2 but could not find the socat bridge socket. Follow the [WSL2 setup](#wsl2-setup) instructions above to start the bridge.

Run with verbose logs to see which socket paths were tried:

```bash
BWBIO_VERBOSE=true bwbio unlock
```

### `Failed to connect to desktop app` / socket `ENOENT`

If verbose logs show connection attempts to `.../s.bw` failing with `ENOENT`, `bwbio` cannot find the Desktop IPC socket.

1. Open the Bitwarden Desktop app (unlock temporarily only if needed to access settings).
2. In Desktop settings, enable `Allow browser integration`.
3. Retry with verbose logs:

```bash
BWBIO_VERBOSE=true bwbio unlock
```

## Platforms

- **macOS** — Touch ID (including App Store builds) — tested
- **Windows** — Windows Hello — tested (community)
- **Linux** — Polkit — should work, not yet tested
- **WSL2** — Windows Hello via socat bridge — see below

The IPC protocol is the same across platforms. If you try Linux, please [open an issue](https://github.com/jeanregisser/bitwarden-cli-bio/issues) and let us know how it goes!

### WSL2 setup

In WSL2, the Bitwarden Desktop app runs on the Windows host. Its IPC socket (a Windows named pipe) is not directly reachable from inside WSL2. You need to bridge it using `socat` and `npiperelay`.

**Prerequisites:**

1. [npiperelay](https://github.com/jstarks/npiperelay) installed on Windows (e.g. `winget install jstarks.npiperelay` or Scoop: `scoop install npiperelay`) and on the Windows `PATH`
2. `socat` installed in WSL (`sudo apt install socat`)
3. Bitwarden Desktop app running with "Allow browser integration" enabled

**Start the bridge:**

`bwbio` ships a helper script that handles everything:

```bash
bwbio-wsl-bridge          # start (idempotent)
bwbio-wsl-bridge --status # check if running
bwbio-wsl-bridge --stop   # stop it
bwbio-wsl-bridge --pipe   # print the computed pipe name
```

Add it to `~/.bashrc` or `~/.profile` to auto-start each session:

```bash
bwbio-wsl-bridge
```

Once the bridge is running, `bwbio` will automatically find it and use Windows Hello.

If `USERPROFILE` is not set in your WSL environment (common when not launched from Windows Terminal), the script falls back to scanning `/mnt/c/Users/` for your Windows username automatically.

## Supply chain trust

- **Zero runtime dependencies** — only Node.js built-in modules, nothing from npm at runtime
- Every push to `main` is automatically built and published via [semantic-release](https://github.com/semantic-release/semantic-release), with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) enabled
- No human runs `npm publish` — releases come directly from GitHub Actions
- Each package on npm links back to the exact source commit and CI run that produced it
- You can verify this on the [npm package page](https://www.npmjs.com/package/bitwarden-cli-bio) (look for the "Provenance" badge)

## Background

This should really be a feature of the official CLI. A [PR was proposed](https://github.com/bitwarden/clients/pull/18273) but was closed — the Bitwarden team wants to wait until they have a proper IPC framework. This wrapper fills the gap in the meantime using the same IPC code from that PR.

## License

[MIT](LICENSE)
