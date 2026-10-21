#!/bin/sh
# Install or update gnomon — Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/eljaplacido/gnomonharness/master/scripts/install.sh | sh
#
# Re-running it is how you update; `gnomon update` runs it for you.
#
# WHAT IT DOES, in order, and stops at the first thing that fails:
#   1. Checks for Node >= 20 and npm. It never installs Node: that needs root,
#      and a script piped from the internet should not be asking for it. It
#      prints the command for this OS instead.
#   2. Resolves the release: the latest one, or GNOMON_VERSION=0.2.3 to pin.
#   3. Installs the npm package — from the registry when that version is
#      published there, otherwise from the release's own tarballs.
#   4. Fetches this platform's native binaries (gnomon-surface and friends)
#      into ~/.local/share/gnomon/bin, where gnomon looks for them with no
#      environment variable set.
#   Every downloaded file is checked against the release's SHA256SUMS (or,
#   for files a release's SHA256SUMS predates, the SHA-256 digest GitHub
#   records for the asset). A mismatch, or a file with no digest at all,
#   aborts the install before anything is installed.
#
# Environment:
#   GNOMON_VERSION      install this release instead of the latest (0.2.3 or v0.2.3)
#   GNOMON_NPM_PREFIX   npm prefix to install into (default: npm's global prefix
#                       when writable, else ~/.local — no sudo either way)
#   GNOMON_NO_NATIVE=1  skip the native binaries
#   GITHUB_TOKEN        optional; lifts GitHub's anonymous API rate limit
#
# Windows: use scripts/install.ps1 (irm …/install.ps1 | iex).

# Everything is inside main(), called on the last line, so a download cut off
# halfway through `curl | sh` runs nothing rather than half a script.
set -eu

REPO="${GNOMON_REPO:-eljaplacido/gnomonharness}"
PACKAGE="gnomon-harness"
LIBS="gnomon-core gnomon-natives gnomon-tui"
NATIVES="gnomon-surface gnomon-enums gnomon-edit gnomon-exec"

say() { printf '%s\n' "$*"; }
step() { # bold on a terminal only: a log file or CI should not get escape codes
    if [ -t 1 ]; then printf '\n\033[1m==> %s\033[0m\n' "$*"; else printf '\n==> %s\n' "$*"; fi
}
die() { printf '\ngnomon install: %s\n' "$*" >&2; exit 1; }

# Node's own fetch, for machines with neither curl nor wget — node:22-slim is
# one, and `gnomon update` runs this script on whatever machine gnomon is on.
# curl and wget stay first because they honour HTTPS_PROXY and Node 20 does not.
node_get() { # url [dest] — to dest, or to stdout
    node -e '
        const [url, dest] = process.argv.slice(1);
        const headers = { "User-Agent": "gnomon-install" };
        if (url.startsWith("https://api.github.com/")) {
            headers.Accept = "application/vnd.github+json";
            if (process.env.GITHUB_TOKEN) headers.Authorization = "Bearer " + process.env.GITHUB_TOKEN;
        }
        fetch(url, { headers }).then(async (r) => {
            if (!r.ok) { console.error(url + ": HTTP " + r.status); process.exit(22); }
            const b = Buffer.from(await r.arrayBuffer());
            if (dest) require("fs").writeFileSync(dest, b); else process.stdout.write(b);
        }).catch((e) => { console.error(url + ": " + e.message); process.exit(22); });
    ' "$@"
}

download() { # url dest
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 2 -o "$2" "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" "$1"
    else
        node_get "$1" "$2"
    fi
}

api() { # path -> stdout. GitHub's REST API, authenticated when a token is set.
    url="https://api.github.com/repos/$REPO/$1"
    if command -v curl >/dev/null 2>&1; then
        if [ -n "${GITHUB_TOKEN:-}" ]; then
            curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "$url"
        else
            curl -fsSL -H "Accept: application/vnd.github+json" "$url"
        fi
    elif command -v wget >/dev/null 2>&1; then
        if [ -n "${GITHUB_TOKEN:-}" ]; then
            wget -q -O - --header="Authorization: Bearer $GITHUB_TOKEN" "$url"
        else
            wget -q -O - "$url"
        fi
    else
        node_get "$url"
    fi
}

node_help() {
    say ""
    say "gnomon needs Node.js 20 or newer. $1"
    say "Install it with ONE of these, then re-run this installer:"
    say ""
    case "$OS" in
        darwin)
            say "  brew install node@22 && brew link --overwrite node@22"
            ;;
        *)
            if [ -r /etc/os-release ] && grep -qiE '^(ID|ID_LIKE)=.*(debian|ubuntu)' /etc/os-release; then
                say "  # Ubuntu / Debian (NodeSource):"
                if command -v node >/dev/null 2>&1; then
                    # Measured on 22.04: with the distro's nodejs+npm present,
                    # NodeSource's package dies in dpkg on a file owned by
                    # libnode-dev, and the old node stays. Remove them first.
                    say "  sudo apt-get remove -y nodejs npm libnode-dev && sudo apt-get autoremove -y"
                fi
                say "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
                say "  sudo apt-get install -y nodejs"
                say ""
            fi
            ;;
    esac
    say "  # any OS, no sudo (nvm):"
    say "  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
    say "  . \"\$HOME/.nvm/nvm.sh\" && nvm install 22"
    say ""
    exit 1
}

# sha256 of a file, via node: it is already required, and it is the same on
# every platform — macOS has shasum but no sha256sum, minimal images neither.
sha256() {
    node -e 'const h=require("crypto").createHash("sha256");h.update(require("fs").readFileSync(process.argv[1]));console.log(h.digest("hex"))' "$1"
}

# The expected digest for a file name: SHA256SUMS first, then GitHub's digest
# for the asset. SHA256SUMS lines may carry a `*` (binary mode) before the name.
expected_digest() { # name
    if [ -s "$WORK/SHA256SUMS" ]; then
        d=$(awk -v n="$1" '{ f=$2; sub(/^\*/, "", f); if (f == n) { print $1; exit } }' "$WORK/SHA256SUMS")
        if [ -n "$d" ]; then printf '%s' "$d"; return 0; fi
    fi
    if [ -s "$WORK/release.json" ]; then
        node -e '
            const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
            const a = (r.assets || []).find((x) => x.name === process.argv[2]);
            if (a && typeof a.digest === "string" && a.digest.startsWith("sha256:")) process.stdout.write(a.digest.slice(7));
        ' "$WORK/release.json" "$1"
    fi
}

fetch_verified() { # name -> $WORK/name
    download "https://github.com/$REPO/releases/download/v$VERSION/$1" "$WORK/$1" \
        || die "could not download $1 from release v$VERSION"
    want=$(expected_digest "$1")
    if [ -z "$want" ]; then
        hint=""
        # An empty release.json means the API did not answer — usually its
        # 60-requests-an-hour anonymous limit — so the asset digests are unknown.
        [ -s "$WORK/release.json" ] || hint="
  GitHub's API did not answer (rate limit?); GITHUB_TOKEN=<token> lets it."
        die "no published SHA-256 for $1 in release v$VERSION — refusing to install an unverifiable file$hint"
    fi
    got=$(sha256 "$WORK/$1")
    [ "$got" = "$want" ] || die "SHA-256 MISMATCH for $1
    expected $want
    got      $got
  The download is not the file the release published. Nothing was installed."
    say "  verified $1"
}

main() {
    # ── platform ──────────────────────────────────────────────────────────
    case "$(uname -s)" in
        Linux) OS=linux ;;
        Darwin) OS=darwin ;;
        MINGW* | MSYS* | CYGWIN*)
            die "this is the Linux/macOS installer. On Windows, in PowerShell:
  irm https://raw.githubusercontent.com/$REPO/master/scripts/install.ps1 | iex" ;;
        *) die "unsupported OS: $(uname -s)" ;;
    esac
    case "$(uname -m)" in
        x86_64 | amd64) ARCH=x64 ;;
        aarch64 | arm64) ARCH=arm64 ;;
        *) ARCH="$(uname -m)" ;;
    esac

    # ── Node ──────────────────────────────────────────────────────────────
    step "Checking Node.js"
    command -v node >/dev/null 2>&1 || node_help "No \`node\` was found on PATH."
    NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || node_help "This machine has $(node --version 2>/dev/null || echo 'an unreadable node')."
    command -v npm >/dev/null 2>&1 || node_help "Node is here but \`npm\` is not (some distros package it separately: apt-get install npm)."
    say "  node $(node --version), npm $(npm --version)"

    WORK=$(mktemp -d 2>/dev/null || mktemp -d -t gnomon)
    trap 'rm -rf "$WORK"' EXIT
    trap 'exit 130' INT TERM

    # ── release ───────────────────────────────────────────────────────────
    step "Resolving the release"
    if [ -n "${GNOMON_VERSION:-}" ] && [ "${GNOMON_VERSION}" != "latest" ]; then
        VERSION="${GNOMON_VERSION#v}"
        api "releases/tags/v$VERSION" >"$WORK/release.json" 2>/dev/null || : >"$WORK/release.json"
    else
        if api "releases/latest" >"$WORK/release.json" 2>/dev/null; then
            VERSION=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tag_name||"").replace(/^v/,""))' "$WORK/release.json")
        else
            # Rate-limited or offline API: the web redirect names the tag too.
            : >"$WORK/release.json"
            VERSION=$(curl -fsSI "https://github.com/$REPO/releases/latest" 2>/dev/null \
                | tr -d '\r' | sed -n 's|^[Ll]ocation: .*/tag/v\{0,1\}\(.*\)$|\1|p' | tail -n 1)
        fi
    fi
    [ -n "${VERSION:-}" ] || die "could not determine the latest release (set GNOMON_VERSION=x.y.z to pin one)"
    say "  gnomon $VERSION"
    download "https://github.com/$REPO/releases/download/v$VERSION/SHA256SUMS" "$WORK/SHA256SUMS" 2>/dev/null \
        || : >"$WORK/SHA256SUMS"

    # ── where npm installs ────────────────────────────────────────────────
    # npm's global prefix is root-owned with a distro or NodeSource Node, and
    # `sudo npm i -g` is how people end up with a root-owned ~/.npm. So: npm's
    # prefix when this user can write it, otherwise ~/.local, and an existing
    # ~/.local install keeps being updated there.
    if [ -n "${GNOMON_NPM_PREFIX:-}" ]; then
        PREFIX="$GNOMON_NPM_PREFIX"
    elif [ -d "$HOME/.local/lib/node_modules/$PACKAGE" ]; then
        PREFIX="$HOME/.local"
    else
        PREFIX=$(npm prefix -g 2>/dev/null || echo "")
        if [ -z "$PREFIX" ] || ! { [ -w "$PREFIX/lib" ] || { [ ! -e "$PREFIX/lib" ] && [ -w "$PREFIX" ]; }; }; then
            PREFIX="$HOME/.local"
        fi
    fi
    mkdir -p "$PREFIX" 2>/dev/null || die "cannot create npm prefix $PREFIX"
    [ -w "$PREFIX" ] || die "npm prefix $PREFIX is not writable by $(id -un). Re-run as its owner, or with GNOMON_NPM_PREFIX=\$HOME/.local"

    # ── the npm package ───────────────────────────────────────────────────
    step "Installing $PACKAGE $VERSION into $PREFIX"
    if npm view "$PACKAGE@$VERSION" version >/dev/null 2>&1; then
        say "  from the npm registry"
        npm install -g --prefix "$PREFIX" --no-audit --no-fund "$PACKAGE@$VERSION" >"$WORK/npm.log" 2>&1 \
            || { cat "$WORK/npm.log" >&2; die "npm install failed (log above)"; }
        # A tarball install left the libraries as separate globals; the
        # registry copy nests its own, so those would only be clutter.
        for lib in $LIBS; do
            if [ -d "$PREFIX/lib/node_modules/$lib" ]; then
                npm rm -g --prefix "$PREFIX" "$lib" >/dev/null 2>&1 || :
            fi
        done
    else
        # Not on the registry, so its three libraries cannot be resolved by
        # name either: all four tarballs go to npm in one command.
        say "  from the release tarballs (not on the npm registry)"
        TGZ=""
        for p in $LIBS $PACKAGE; do
            fetch_verified "$p-$VERSION.tgz"
            TGZ="$TGZ $WORK/$p-$VERSION.tgz"
        done
        # shellcheck disable=SC2086  # word-splitting $TGZ is the point; no path has spaces (mktemp)
        npm install -g --prefix "$PREFIX" --no-audit --no-fund $TGZ >"$WORK/npm.log" 2>&1 \
            || { cat "$WORK/npm.log" >&2; die "npm install failed (log above)"; }
    fi

    # ── native binaries ───────────────────────────────────────────────────
    BIN_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnomon/bin"
    NATIVE_NOTE=""
    if [ "${GNOMON_NO_NATIVE:-}" = "1" ]; then
        NATIVE_NOTE="native binaries skipped (GNOMON_NO_NATIVE=1)"
    else
        step "Installing the native binaries into $BIN_DIR"
        ARCHIVE="gnomon-$VERSION-$OS-$ARCH.tar.gz"
        if ! grep -q "$ARCHIVE" "$WORK/SHA256SUMS" 2>/dev/null \
            && ! grep -q "\"$ARCHIVE\"" "$WORK/release.json" 2>/dev/null; then
            NATIVE_NOTE="no native binaries are published for $OS-$ARCH; surface, enumerations, session, apply and simulate will not work (launch, prompt, task and init do)"
            say "  $NATIVE_NOTE"
        else
            fetch_verified "$ARCHIVE"
            mkdir -p "$WORK/native" "$BIN_DIR"
            tar -xzf "$WORK/$ARCHIVE" -C "$WORK/native"
            src="$WORK/native/gnomon-$VERSION-$OS-$ARCH"
            for b in $NATIVES; do
                [ -f "$src/$b" ] || die "$ARCHIVE has no $b"
                # Copy then rename: replacing a binary that is running is fine
                # this way, and a half-copied file is never left under its name.
                cp "$src/$b" "$BIN_DIR/.$b.new"
                chmod 755 "$BIN_DIR/.$b.new"
                mv -f "$BIN_DIR/.$b.new" "$BIN_DIR/$b"
            done
            [ -f "$src/GNOMON_BUILD" ] && cp "$src/GNOMON_BUILD" "$BIN_DIR/GNOMON_BUILD"
            printf '%s\n' "$VERSION" >"$BIN_DIR/VERSION"
            say "  $(echo "$NATIVES" | wc -w | tr -d ' ') binaries, release $VERSION"
            # Run each. Placing a binary is not the same as it running here:
            # v0.2.3's Linux builds need glibc 2.39, so on Ubuntu 22.04 (2.35)
            # they installed, verified, and failed on first use — all but
            # gnomon-enums, which is why one is not enough to try.
            for b in $NATIVES; do
                if ! "$BIN_DIR/$b" --help </dev/null >/dev/null 2>"$WORK/native.err"; then
                    NATIVE_NOTE="$b does not run on this system: $(head -n 1 "$WORK/native.err")
        surface, enumerations, session, apply and simulate may fail; launch, prompt, task and init are unaffected"
                    say "  WARNING: $NATIVE_NOTE"
                    break
                fi
            done
        fi
    fi

    # ── done ──────────────────────────────────────────────────────────────
    step "Done"
    GNOMON="$PREFIX/bin/gnomon"
    [ -x "$GNOMON" ] || die "npm reported success but $GNOMON does not exist"
    # `--version` is one line on newer releases and the help text on older
    # ones, whose first line is the same build string.
    say "  $("$GNOMON" --version 2>&1 | head -n 1)"
    # Ask the installed gnomon itself to find a native binary. Releases up to
    # 0.2.3 do not search $BIN_DIR, so for them the binaries are placed,
    # verified, run — and then "native binary not found" on first use.
    if [ -z "$NATIVE_NOTE" ] && [ "${GNOMON_NO_NATIVE:-}" != "1" ]; then
        if ! (cd "$WORK" && unset GNOMON_BIN_OVERRIDE && "$GNOMON" enumerations) >/dev/null 2>&1; then
            NATIVE_NOTE="gnomon $VERSION does not look in $BIN_DIR by itself. Until a newer release, add this to your shell profile:
    export GNOMON_BIN_OVERRIDE=\"$BIN_DIR\""
        fi
    fi
    [ -n "$NATIVE_NOTE" ] && say "  note: $NATIVE_NOTE"

    case ":$PATH:" in
        *":$PREFIX/bin:"*)
            found=$(command -v gnomon 2>/dev/null || echo "")
            if [ -n "$found" ] && [ "$found" != "$GNOMON" ]; then
                say ""
                say "  warning: \`gnomon\` on your PATH is $found, not this install."
                say "  Remove the other copy, or put $PREFIX/bin earlier in PATH."
            fi
            ;;
        *)
            say ""
            case "${SHELL:-}" in
                */zsh) RC="$HOME/.zshrc" ;;
                */bash) RC="$HOME/.bashrc" ;;
                *) RC="$HOME/.profile" ;;
            esac
            say "  $PREFIX/bin is not on your PATH. Add it, then open a new terminal:"
            say "    echo 'export PATH=\"$PREFIX/bin:\$PATH\"' >> $RC"
            ;;
    esac

    say ""
    say "Next:"
    say "  cd your-project && gnomon launch"
    say ""
    say "Update later with \`gnomon update\` (or re-run this installer);"
    say "\`gnomon uninstall\` prints how to remove it."
}

main "$@"
