# The box: one long-running container for Personal Intelligence. It holds the key file on its
# volume and runs the sync timer, Claude Code and `pi mcp` over stdio. Nothing here is specific
# to one host or one owner, and the image holds no secret and no data.
#
# Eleven Unix users: eight described here, and three more below.
#   root      runs the entrypoint, and the owner's own sessions. No process of the box itself
#             stays root once the entrypoint has become the timer.
#   pi        owns the key file, the erasure journal and the files that hold the database URLs
#             and the Google client secret, and is the only user that can read them. The sync
#             timer runs as pi, and starts extraction and the work tick as pi.
#   pimcp     runs the agent API on a pipe, `pi mcp`, for the box's own callers. It reads none of
#             pi's files: only /run/pimcp, whose file root writes and pimcp can read but not
#             change, holding the reader role's URL and nothing else of the database's, and
#             /data/pimcp (0700), where the client tokens of pi-mcp's callers are and a copy of the
#             key file narrowed to what any client can be served, with the erasure journal's mark
#             beside it. Root's wrapper pia writes those two as pimcp after every owner command,
#             from what pi hands it (lib/agent-keys, lib/agent-file), and the timer and the owner's
#             page the mark as pi changes it. No home, no shell, no group but its own, and no sudo
#             rule of its own; agent's and the reasoner's rules start pi-mcp as pimcp, and one of
#             pi's rules writes the mark as pimcp.
#   pihttp    runs the agent API over HTTPS, `pi http`, the box's one process that answers the
#             internet. It reads none of pi's files and none of pimcp's, so no client token of the
#             box's callers, the reasoner's among them: each request brings its own token, which
#             the database resolves. It reads /run/pihttp, as pimcp reads /run/pimcp, and
#             /data/pihttp (0700): its own key copy, narrowed to the clients that may call over
#             HTTPS (every client but the reasoner), the journal's mark, and its log. Written as
#             pimcp's are; one of pi's rules writes the mark as pihttp. No home, no shell, no group
#             but its own, and no sudo rule of its own.
#   agent     is the user Claude Code runs as. It reads none of those. Its one sudo rule starts
#             the agent API as pimcp (see sudoers).
#   reasoner  runs the reasoning loop, the box's one process that sends what it reads to a
#             model. It reads none of pi's files, no client token and no key file, holds no
#             database URL, and has no home, no shell and no directory on the volume. It reads
#             one file, /run/reasoner/reasoner.env: its model and the model's key. Its one sudo
#             rule starts the agent API as pimcp; one of pi's rules starts it (see sudoers).
#   tester    runs the weekly outcome test, built off. It reads one
#             file, /run/tester/tester.env, written only when the service sets PI_OUTCOME_TEST=1.
#   pisend    runs `pi send`, the one process that holds the send role's URL and the send
#             client's secret, in /run/pisend, which no other user but root reads. It reads none
#             of pi's files: pi-send, which only root runs, hands it a copy of the key file
#             narrowed to what sending needs, and of the erasure journal, for one send command
#             at a time. It has no home, no shell, no group but its own, no directory on the
#             volume and no sudo rule, and no sudo rule names it.
# Two more, each below: pirestricted, the restricted reader, and pinotify, which runs `pi notify`,
# the work-notice sender, and reads only /run/pinotify and /data/pinotify. And the owner's page's:
# pitail runs tailscaled and nothing else, and is the one other member of piweb,
# the group of the page's socket.
#
# One volume, mounted at /data, holds everything that must survive a redeploy:
#   /data/pi      (pi:piweb, 0710) keys.json, keys.json.erasures, keys.json.agent-held (the
#                                compartments the agent API's copy has held), sync.log,
#                                extract.log, work.log, web.log, and the page's sockets while it
#                                runs; piweb only searches it, to reach the page's socket by
#                                name
#   /data/pimcp   (pimcp, 0700)  keys.json, the narrowed key copy, and keys.json.erasures, the
#                                journal's mark; tokens/
#   /data/pihttp  (pihttp, 0700) keys.json, `pi http`'s own narrowed key copy, and
#                                keys.json.erasures, the journal's mark; http.log
#   /data/read-hold (root)       while it exists, pi-mcp answers nothing (pi-read-hold)
#   /data/sync-hold (root)       while it exists, the timer starts nothing
#   /data/extract-on (root)      while it exists, the timer starts extraction; only the owner
#                                makes it
#   /data/agent   (agent, 0700)  the agent's home: Claude Code's configuration and sign-in
#   /data/pinotify (pinotify, 0700) webhooks.json, the webhook keys the pia wrapper writes, and
#                                notify.log
#   /data/pitail  (pitail, 0700) tailscaled's state: the node's key and its tailnet login
#   /data/pi-root (root, 0700)   only where the owner ran `pi-migrate --enable-auto`: migrate.env,
#                                the migration role's password, migrate.log, and migrate-holds,
#                                the holds lib/migrate-start took
# The three switch files are in /data, which is root's, so the owner's root `touch` of one never
# follows a link pi or agent planted. The files written from the environment at each start are
# in /run/pi, /run/pimcp, /run/pihttp, /run/reasoner, /run/pisend, /run/pirestricted and
# /run/pinotify and are not kept, and
# the superuser scripts' server and pi-send's lock in /run/pi-root, which only root reads or writes.
# /run is the container's own disk unless the host mounts memory there; it is not the volume.

# The base is named by digest, so the image that was smoke-tested is the image that is built
# again: the tag alone moves. This is node:24-bookworm-slim (Node 24.21.0), for
# amd64 and arm64. To take a newer base, change the digest, build, and run smoke.sh.
#
# The owner's page is built in a stage of its own, with the client's dev dependencies (vite and its
# React plugin) and nothing else of the repository's. Only the built files reach the box: the
# runtime stage holds none of the client's node_modules.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS web-client
WORKDIR /build
COPY . .
RUN corepack enable pnpm \
 && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --ignore-scripts --filter "@intelligence/pi-web-client..." \
 && pnpm --dir apps/web build

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# Packages added to the base image, and why each is needed:
#   sudo               the agent user's one rule, and a session for agent on a terminal of its own
#   postgresql-client  psql, for the two statements only a Postgres superuser can run
#                      (pi-db-init, pi-migrate). `pi` itself never uses it
#   ca-certificates    TLS to Google and to the model vendor
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates sudo postgresql-client \
 && rm -rf /var/lib/apt/lists/*

# Fixed ids, so files on the volume keep their owners across images.
RUN groupadd --system --gid 900 pi \
 && useradd --system --uid 900 --gid pi --home-dir /data/pi --no-create-home --shell /usr/sbin/nologin pi \
 && groupadd --system --gid 901 reasoner \
 && useradd --system --uid 901 --gid reasoner --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin reasoner \
 && groupadd --system --gid 909 tester \
 && useradd --system --uid 909 --gid tester --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin tester \
 && groupadd --system --gid 902 pisend \
 && useradd --system --uid 902 --gid pisend --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin pisend \
 && groupadd --gid 1100 agent \
 && useradd --uid 1100 --gid agent --home-dir /data/agent --no-create-home --shell /bin/bash agent

# The restricted reader's user: pirestricted, the only reader of the restricted key root and of
# /run/pirestricted, where its database URL is. It is in no group but its own, the group pi
# included, and has no shell. This image makes the user and its URL's file and nothing more: no
# process runs as it yet, and it has no directory on the volume.
RUN groupadd --system --gid 903 pirestricted \
 && useradd --system --uid 903 --gid pirestricted --home-dir /data/pirestricted --no-create-home --shell /usr/sbin/nologin pirestricted

# The work-notice sender's user: pinotify runs
# `pi notify` and reads only /run/pinotify/notify.env and /data/pinotify (0700), where the webhook
# keys are. It is in no group but its own, the group pi included, has no shell, and no sudo rule
# names it: it connects out to the addresses the owner registered, so it holds nothing else.
RUN groupadd --system --gid 904 pinotify \
 && useradd --system --uid 904 --gid pinotify --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin pinotify

# The owner's page's users: pitail runs tailscaled in userspace networking, so no long-running
# process is root, and has no home, no shell and no sudo rule. piweb is the group of the page's
# socket, made 0660 by `pi web serve`, which web-serve starts with piweb its primary group; pitail
# is its one member, so pitail alone besides pi opens the socket. pi is not a member: its other
# processes never hold it. The agent API's users: pimcp runs `pi mcp` and pihttp runs `pi http`, as
# the header says. Each is in no group but its own, the group pi included.
RUN groupadd --system --gid 907 pimcp \
 && useradd --system --uid 907 --gid pimcp --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin pimcp \
 && groupadd --system --gid 908 pihttp \
 && useradd --system --uid 908 --gid pihttp --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin pihttp

RUN groupadd --system --gid 905 pitail \
 && useradd --system --uid 905 --gid pitail --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin pitail \
 && groupadd --system --gid 906 piweb \
 && usermod --append --groups piweb pitail

# Tailscale, its two static binaries from Tailscale's own packages, pinned and checked against the
# SHA-256 Tailscale publishes beside each (pkgs.tailscale.com/stable, the .sha256 files),
# for the two architectures the base is built for. Owned by root, so pitail runs them
# and cannot change them. Downloaded with node, which the base has, so no package is added. To take
# a newer version, change the version and both sums, and the version smoke.sh checks.
ARG TAILSCALE_VERSION=1.104.4
RUN set -eu; \
    arch=$(dpkg --print-architecture); \
    case $arch in \
      amd64) sum=624ea093d47d62cf56f17b8332d74b8decda4a1faa610ebc60a1de334b2b3dc9 ;; \
      arm64) sum=a1c249ce6bdebef62e1ae3b997595555bce2ae4709bf95a718e9ca7a129dad7e ;; \
      *) echo "no Tailscale checksum for $arch" >&2; exit 1 ;; \
    esac; \
    dir="tailscale_${TAILSCALE_VERSION}_${arch}"; \
    node -e 'fetch(process.argv[1]).then(async (r) => { if (!r.ok) throw new Error(`http ${r.status}`); require("node:fs").writeFileSync(process.argv[2], Buffer.from(await r.arrayBuffer())); })' "https://pkgs.tailscale.com/stable/$dir.tgz" /tmp/tailscale.tgz; \
    echo "$sum  /tmp/tailscale.tgz" | sha256sum -c -; \
    tar -xzf /tmp/tailscale.tgz -C /usr/local/bin --strip-components=1 --no-same-owner "$dir/tailscale" "$dir/tailscaled"; \
    chown root:root /usr/local/bin/tailscale /usr/local/bin/tailscaled; \
    chmod 755 /usr/local/bin/tailscale /usr/local/bin/tailscaled; \
    rm -f /tmp/tailscale.tgz

# Claude Code, owned by root, so the agent user can run it and cannot change it. It is signed in at
# run time; nothing of the owner's is in the image. Pinned as Tailscale is: the package's tarball
# and its platform package's tarball, for the two architectures the base is built for, are fetched
# from the npm registry and checked against the sha512 integrity the registry publishes for each
# (`npm view <package>@<version> dist.integrity`), recorded here. They are unpacked where `npm
# install --global` would put them, without npm, which would fetch every platform package again
# unchecked. The package's install script (install.cjs) then runs, as root at build time, as npm
# would run it: the package's `claude` is a placeholder that the script replaces with the native
# binary from the platform package. The install runs before the repository is copied in, so the
# script sees nothing of it. To take a newer version, change the version and all three integrity
# values.
ARG CLAUDE_CODE_VERSION=2.1.288
RUN set -eu; \
    arch=$(dpkg --print-architecture); \
    main=sha512-tnc8XuK5xQkyE6oowhhSPIjLuNc0S3MkjIHqycDsKP6yJlLtIjMt6v1TOkYLUiumcZ9jOgJZ6h9Vn3/f0murdQ==; \
    case $arch in \
      amd64) platform=linux-x64; sum=sha512-m80cJZimlKjRiwveadPgAfubhbmwa2nF85gg20WbjnHl6QKMad0bXiMp6JNcPeSZsr0N1KJ/wkR34rRoiyyYyg== ;; \
      arm64) platform=linux-arm64; sum=sha512-sP12YSgo3CQw4gM+C0AaIAHawW1xN4j2OKlGZFobFE2UG5eMRVQslQug8bXuVsldI1F+HT3vvfRNB3mdDge18A== ;; \
      *) echo "no Claude Code integrity for $arch" >&2; exit 1 ;; \
    esac; \
    fetch_checked() { node -e 'const [url, file, want] = process.argv.slice(1); fetch(url).then(async (r) => { if (!r.ok) throw new Error(`http ${r.status}`); const body = Buffer.from(await r.arrayBuffer()); const got = `sha512-${require("node:crypto").createHash("sha512").update(body).digest("base64")}`; if (got !== want) throw new Error(`integrity mismatch for ${url}`); require("node:fs").writeFileSync(file, body); })' "$1" "$2" "$3"; }; \
    fetch_checked "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${CLAUDE_CODE_VERSION}.tgz" /tmp/claude-code.tgz "$main"; \
    fetch_checked "https://registry.npmjs.org/@anthropic-ai/claude-code-${platform}/-/claude-code-${platform}-${CLAUDE_CODE_VERSION}.tgz" /tmp/claude-code-platform.tgz "$sum"; \
    dir=/usr/local/lib/node_modules/@anthropic-ai/claude-code; \
    mkdir -p "$dir/node_modules/@anthropic-ai/claude-code-${platform}"; \
    tar -xzf /tmp/claude-code.tgz -C "$dir" --strip-components=1 --no-same-owner; \
    tar -xzf /tmp/claude-code-platform.tgz -C "$dir/node_modules/@anthropic-ai/claude-code-${platform}" --strip-components=1 --no-same-owner; \
    (cd "$dir" && node install.cjs); \
    ln -s ../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe /usr/local/bin/claude; \
    rm -f /tmp/claude-code.tgz /tmp/claude-code-platform.tgz

# The repository, and what `pi` and the reasoner need to run from source. Owned by root and writable
# by nobody else: pi and agent run this code and cannot change it.
WORKDIR /opt/intelligence
COPY . .
RUN corepack enable pnpm \
 && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@intelligence/pi..." --filter "@intelligence/personal-reasoner..." \
 && rm -rf /root/.cache /root/.local /root/.npm \
 && chown -R root:root /opt/intelligence \
 && chmod -R go-w /opt/intelligence

# The owner's page, built above, beside pi in the repository's tree, where `pi web` reads its
# manifest once at start. Root-owned and read-only: files 0444, folders 0555.
COPY --from=web-client /build/apps/web/dist /opt/intelligence/apps/web/dist
RUN chown -R root:root /opt/intelligence/apps/web/dist \
 && find /opt/intelligence/apps/web/dist -type d -exec chmod 555 {} + \
 && find /opt/intelligence/apps/web/dist -type f -exec chmod 444 {} +

# The entry, the timer and the wrappers. Each is root-owned; the six that only the owner's
# own session runs are closed to everyone else.
RUN install -d -m 755 /usr/local/lib/pi \
 && install -m 755 deploy/lib/entrypoint deploy/lib/sync-timer deploy/lib/canary-run deploy/lib/as-pi deploy/lib/run deploy/lib/agent-session deploy/lib/reasoner-run deploy/lib/tester-run deploy/lib/send-run deploy/lib/mcp-run deploy/lib/agent-keys deploy/lib/agent-file deploy/lib/http-serve deploy/lib/wake-serve deploy/lib/wake-run deploy/lib/notify-serve deploy/lib/notify-run deploy/lib/web-serve deploy/lib/tail-serve deploy/lib/tail-config deploy/lib/supervise deploy/lib/rotate-logs deploy/lib/heartbeat deploy/lib/held-answer deploy/lib/watchdog deploy/lib/predeploy /usr/local/lib/pi/ \
 && install -m 700 deploy/lib/migrate-start /usr/local/lib/pi/ \
 && install -m 644 deploy/lib/superuser.sh deploy/lib/role-check.sql /usr/local/lib/pi/ \
 && install -m 755 deploy/bin/pi deploy/bin/pi-admin deploy/bin/pi-sync deploy/bin/pi-extract deploy/bin/pi-mcp deploy/bin/pi-work deploy/bin/pi-reasoner deploy/bin/pi-tester deploy/bin/agent-run /usr/local/bin/ \
 && install -m 700 deploy/bin/pi-db-init deploy/bin/pi-migrate deploy/bin/pi-token deploy/bin/pi-read-hold deploy/bin/pi-send deploy/bin/pi-notify /usr/local/bin/ \
 && ln -s pi-admin /usr/local/bin/pia \
 && install -m 440 deploy/sudoers /etc/sudoers.d/pi-box \
 && visudo -c -q \
 && printf '%s\n' 'unset HISTFILE' >> /root/.bashrc

WORKDIR /
ENTRYPOINT ["/usr/local/lib/pi/entrypoint"]
