#!/usr/bin/env bash
# The box's smoke test. It runs a built image beside a throwaway Postgres 18, with made-up
# secrets, and checks what the image is for:
#
# It never touches a real account: no Google, no model vendor, no real database. Its network is
# internal, so no container it starts reaches the internet, OpenRouter included, whatever key it
# holds; the box checks that it has no way out.
#
#   docker build -f deploy/Dockerfile -t pi-box:smoke .
#   deploy/smoke.sh pi-box:smoke
#
# The Postgres image is the one the repository's own server uses, so it is already on a machine
# that has run `pnpm db:up`. PI_SMOKE_PG_IMAGE names another. Every
# container, volume and network it makes is removed when it ends.
set -u

image=${1:?usage: smoke.sh IMAGE}
pg_image=${PI_SMOKE_PG_IMAGE:-postgres:18}
id=pi-smoke-$$
net=$id
pg=$id-pg
box=$id-box
novol=$id-novol
notroot=$id-notroot
badenv=$id-badenv
sendenv=$id-sendenv
# The fake key endpoint. The box joins its network namespace, so the endpoint is on the box's own
# loopback and stays up across the box's restarts.
keys=$id-keys
keyurl=http://127.0.0.1:8787/api/v1/key
vol=$id-data
tmp=$(mktemp -d)

cleanup() {
  docker rm -f -v "$box" "$keys" "$pg" "$novol" "$notroot" "$badenv" "$sendenv" > /dev/null 2>&1
  docker volume rm "$vol" > /dev/null 2>&1
  docker network rm "$net" > /dev/null 2>&1
  rm -rf "$tmp"
}
trap cleanup EXIT

passed=0
failed=0
ok() { printf 'ok    %s\n' "$1"; passed=$((passed + 1)); }
no() { printf 'FAIL  %s\n' "$1"; failed=$((failed + 1)); }
# must DESCRIPTION COMMAND...: the command succeeds. mustnot: it fails.
must() { local d=$1; shift; if "$@" > /dev/null 2>&1; then ok "$d"; else no "$d"; fi; }
mustnot() { local d=$1; shift; if "$@" > /dev/null 2>&1; then no "$d"; else ok "$d"; fi; }
# is DESCRIPTION EXPECTED ACTUAL
is() { if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (expected '$2', got '$3')"; fi; }

random() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }
# A command in the box as root, as an owner's session is.
root() { docker exec -i "$box" "$@"; }
# A command in the box as the agent user, the way the owner starts one.
agent() { docker exec -i "$box" agent-run "$@"; }
# A command in the box as the pi user.
as_pi() { docker exec -i "$box" setpriv --reuid=pi --regid=pi --init-groups "$@"; }
# A command in the box as the agent API's user on a pipe.
as_pimcp() { docker exec -i "$box" setpriv --reuid=pimcp --regid=pimcp --init-groups "$@"; }
# A command in the box as the agent API's user over HTTPS.
as_pihttp() { docker exec -i "$box" setpriv --reuid=pihttp --regid=pihttp --init-groups "$@"; }
# A command in the box as the reasoner user.
as_reasoner() { docker exec -i "$box" setpriv --reuid=reasoner --regid=reasoner --init-groups "$@"; }
# A command in the box as the send user.
as_pisend() { docker exec -i "$box" setpriv --reuid=pisend --regid=pisend --init-groups "$@"; }
# A command in the box as the work-notice sender's user.
as_pinotify() { docker exec -i "$box" setpriv --reuid=pinotify --regid=pinotify --init-groups "$@"; }
# A command in the box as Tailscale's user.
as_pitail() { docker exec -i "$box" setpriv --reuid=pitail --regid=pitail --init-groups "$@"; }
# sudo refused it: not allowed, or it wanted a password agent does not have.
sudo_refuses() { agent sudo -n "$@" 2>&1 | grep -qE 'a password is required|not allowed'; }
# Every line of the box's own output is one of its fixed lines: an event and a code, no more.
# Tailscale's login link is the one line with a value, in its own fixed shape. The entrypoint's
# and the timer's lines carry their time and level, a hold's end its minutes, and coverage's
# silent line a row's id; Tailscale's lines carry `at` and `level` too. An entrypoint line about a
# variable names it in `name`.
only_fixed_lines() {
  ! docker logs "$box" 2>&1 | grep -qvE \
    -e '^\{"event":"tailscale","at":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z","level":"warn","code":"login_url","url":"https://login\.tailscale\.com/a/[0-9A-Za-z]+"\}$' \
    -e '^\{"event":"[a-z0-9_]+","at":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z","level":"(info|warn|error)"(,"code":"[a-z0-9_]+")?(,"name":"[A-Z0-9_]+")?(,"counts":\{"minutes":[0-9]+\})?\}$' \
    -e '^\{"event":"coverage_silent","ids":\{"[a-z_]+":"[A-Za-z0-9_:]+"\},"code":"[a-z0-9_]+"\}$'
}
# start_code CONTAINER CODE [NAME]: the container's output holds the entrypoint's line with CODE
# (and NAME), its time and level aside.
start_code() {
  if [ -n "${3:-}" ]; then
    docker logs "$1" 2>&1 | sed -E 's/,"at":"[^"]*","level":"[a-z]+"//' | grep -qx "{\"event\":\"box_start\",\"code\":\"$2\",\"name\":\"$3\"}"
  else
    docker logs "$1" 2>&1 | sed -E 's/,"at":"[^"]*","level":"[a-z]+"//' | grep -qx "{\"event\":\"box_start\",\"code\":\"$2\"}"
  fi
}
# start_count CONTAINER CODE: how many of the entrypoint's lines carry CODE.
start_count() { docker logs "$1" 2>&1 | grep -c "^{\"event\":\"box_start\",\"at\":\"[^\"]*\",\"level\":\"[a-z]*\",\"code\":\"$2\""; }
# box_failed EVENT CODE: the timer's fixed line for a child that failed, with its time and level,
# on the box's output.
box_failed() { docker logs "$box" 2>&1 | grep -qE "^\\{\"event\":\"$1\",\"at\":\"[0-9TZ:-]+\",\"level\":\"error\",\"code\":\"$2\"\\}\$"; }
# A pi line without the time and level the box's wrappers add.
untimed() { sed -E 's/,"at":"[^"]*","level":"[a-z]+"//'; }
wait_for() { local n=$1; shift; while [ "$n" -gt 0 ]; do if "$@" > /dev/null 2>&1; then return 0; fi; sleep 1; n=$((n - 1)); done; return 1; }
# One pi-migrate run with the superuser's answers: its last line, then its exit status. The last
# line alone is not enough: the exit trap prints it however the migration ended.
migrate_result() { local out status; out=$(printf 'postgres\n%s\n' "$super" | root pi-migrate 2> /dev/null); status=$?; printf '%s %s' "$(printf '%s\n' "$out" | tail -n 1)" "$status"; }
# One pi-migrate run whose whole output is kept: migrated holds it, and migrated_status its status.
migrate_keep() { migrated=$(printf 'postgres\n%s\n' "$super" | root pi-migrate 2> "$tmp/migrate.err"); migrated_status=$?; }

# Throwaway values. The Google client secret doubles as a canary: it must show up nowhere but
# in pi's own file.
super=$(random)
export PI_DATABASE_URL_ADMIN="postgres://pi_admin:$(random)@$pg:5432/pi"
export PI_DATABASE_URL_WRITER="postgres://pi_writer:$(random)@$pg:5432/pi"
export PI_DATABASE_URL_READER="postgres://pi_reader:$(random)@$pg:5432/pi"
export PI_DATABASE_URL_PIPELINE="postgres://pi_pipeline:$(random)@$pg:5432/pi"
export PI_DATABASE_URL_WORK="postgres://pi_work:$(random)@$pg:5432/pi"
# The restricted reader's role.
export PI_DATABASE_URL_RESTRICTED="postgres://pi_restricted:$(random)@$pg:5432/pi"
# A model is set and no budget is, so extract.env shows both halves of "only when set".
export PI_EXTRACT_MODEL=smoke/not-a-model
export PI_DECIDE_MODEL=typesafe/jev-1.13
export PI_GOOGLE_CLIENT_ID=smoke-client-id
export PI_GOOGLE_CLIENT_SECRET="smoke-canary-$(random)"
canary=$PI_GOOGLE_CLIENT_SECRET
# A sentinel model key: it must show up nowhere but in model-key.env.
export PI_OPENROUTER_KEY="smoke-model-key-$(random)"
modelkey=$PI_OPENROUTER_KEY
# The reasoner's model and key. The key is a sentinel too: it must show up nowhere but in
# reasoner.env. No run is ever queued here, so no model is called.
export PI_REASONER_MODEL=smoke/not-a-model
export PI_REASONER_MODEL_KEY="smoke-reasoner-key-$(random)"
reasonerkey=$PI_REASONER_MODEL_KEY
# The send role's URL and the send client. The URL's password is 64 lower-case hexadecimal
# characters, as the laptop loop makes it; it and the client's secret are sentinels: they must show
# up nowhere but in send.env and the send process.
proxypw=$(random)$(random)
export PI_DATABASE_URL_PROXY="postgres://pi_proxy:$proxypw@$pg:5432/pi"
export PI_SEND_GOOGLE_CLIENT_ID=smoke-send-client-id
export PI_SEND_GOOGLE_CLIENT_SECRET="smoke-send-secret-$(random)"
sendsecret=$PI_SEND_GOOGLE_CLIENT_SECRET
# The notify role's URL, its password made as the proxy's is; a sentinel too: it
# must show up nowhere but in notify.env and the sender's process.
notifypw=$(random)$(random)
export PI_DATABASE_URL_NOTIFY="postgres://pi_notify:$notifypw@$pg:5432/pi"
# The two keys' spend ceilings, above the fake endpoint's 5-dollar limit. The override of the key
# endpoint is passed to the box by name below and is never exported, so a box started as
# in production, with the variables exported here, does not hold it.
export PI_EXTRACT_KEY_CAP_USD=10
export PI_REASONER_KEY_CAP_USD=30
# Lens's capture ceiling is set and its mirror timings and lane switches are not, so the files
# show both halves of "only when set".
export PI_CAPTURE_STORAGE_CEILING_BYTES=4000000000
# The fake key endpoint (HO5): its one key path answers a 5-dollar limit that never resets, with
# all of it left; every other path, and the key path while /tmp/garbled exists in its own
# container, answers a page that does not parse. So the box's files are never edited to aim it
# elsewhere. It records each request's method and path, and nothing of its headers, so no key is
# kept.
key_endpoint='const fs = require("node:fs");
require("node:http").createServer((req, res) => {
  fs.appendFileSync("/tmp/asked", `${req.method} ${req.url}\n`);
  if (req.method === "GET" && req.url === "/api/v1/key" && !fs.existsSync("/tmp/garbled")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { label: "smoke", usage: 0, limit: 5, limit_remaining: 5, limit_reset: null } }));
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>not json</html>");
  }
}).listen(8787, "127.0.0.1");'
key_asked() { docker exec "$keys" sh -c 'cat /tmp/asked 2> /dev/null | grep -cx "GET /api/v1/key"'; }

echo '# start'
docker network create --internal "$net" > /dev/null || exit 1
docker volume create "$vol" > /dev/null || exit 1
docker run -d --name "$pg" --network "$net" --tmpfs /var/lib/postgresql -e POSTGRES_PASSWORD="$super" "$pg_image" > /dev/null || exit 1
docker run -d --name "$keys" --network "$net" --user node --entrypoint /usr/local/bin/node "$image" -e "$key_endpoint" > /dev/null || exit 1
wait_for 30 docker exec "$keys" node -e 'fetch("http://127.0.0.1:8787/ready").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' || { echo 'the fake key endpoint did not start'; docker logs "$keys"; exit 1; }
docker run -d --name "$box" --network "container:$keys" -v "$vol:/data" -e PI_DATABASE_URL_RESTRICTED \
  -e PI_DATABASE_URL_ADMIN -e PI_DATABASE_URL_WRITER -e PI_DATABASE_URL_READER -e PI_DATABASE_URL_PIPELINE -e PI_DATABASE_URL_WORK -e PI_EXTRACT_MODEL -e PI_DECIDE_MODEL -e PI_GOOGLE_CLIENT_ID -e PI_GOOGLE_CLIENT_SECRET -e PI_OPENROUTER_KEY -e PI_REASONER_MODEL -e PI_REASONER_MODEL_KEY -e PI_DATABASE_URL_PROXY -e PI_SEND_GOOGLE_CLIENT_ID -e PI_SEND_GOOGLE_CLIENT_SECRET -e PI_DATABASE_URL_NOTIFY \
  -e PI_EXTRACT_KEY_CAP_USD -e PI_REASONER_KEY_CAP_USD -e PI_CAPTURE_STORAGE_CEILING_BYTES -e "PI_OPENROUTER_KEY_URL=$keyurl" \
  -e PI_HTTP_ENABLED=1 "$image" > /dev/null || exit 1
wait_for 60 docker exec "$pg" pg_isready -h 127.0.0.1 -U postgres || { echo 'Postgres did not start'; exit 1; }
wait_for 30 root test -f /run/pimcp/mcp.env || { echo 'the box did not start'; docker logs "$box"; exit 1; }
# The model key's import runs before the timer starts, and may wait out its timeout.
ready() { start_code "$box" ready; }
wait_for 60 ready || { echo 'the box did not get to ready'; docker logs "$box"; exit 1; }

echo '# the entrypoint'
is 'the first process runs as pi' pi "$(root stat -c %U /proc/1)"
# Matched at its end: under emulation of another architecture the emulator's name comes first.
case $(root sh -c "tr '\0' ' ' < /proc/1/cmdline") in
  *'/bin/sh /usr/local/lib/pi/sync-timer ') ok 'the first process is the sync timer' ;;
  *) no 'the first process is the sync timer' ;;
esac
# Read as pi: without the ptrace capability not even root reads another user's environment.
is 'the first process holds the path in its environment and nothing else' 'PATH=/usr/local/bin:/usr/bin:/bin' "$(as_pi sh -c "tr '\0' '\n' < /proc/1/environ")"
is "the volume has a directory for pi and one for agent, each closed to the other, pi's searchable by piweb alone" 'pi:piweb 710 agent:agent 700' "$(root stat -c '%U:%G %a' /data/pi /data/agent | tr '\n' ' ' | sed 's/ $//')"
is 'each secret file is pi-only' 'pi:600 pi:600 pi:600 pi:600' "$(root stat -c '%U:%a' /run/pi/admin.env /run/pi/sync.env /run/pi/extract.env /run/pi/work.env | tr '\n' ' ' | sed 's/ $//')"
# The agent API's files: its user's alone, in a directory root owns, and none of pi's.
is 'pimcp has fixed ids, no home and no shell' 'pimcp 907 907 /nonexistent /usr/sbin/nologin' "$(root getent passwd pimcp | awk -F: '{print $1, $3, $4, $6, $7}')"
is 'pimcp is in its own group alone, not in pi' pimcp "$(root id -nG pimcp)"
is '/run/pimcp is root:pimcp, mode 750, and /data/pimcp pimcp:pimcp, mode 700' 'root:pimcp 750 pimcp:pimcp 700' "$(root stat -c '%U:%G %a' /run/pimcp /data/pimcp | tr '\n' ' ' | sed 's/ $//')"
is "mcp.env is root's, read by pimcp's group alone, and http.env root's, read by pihttp's" 'root:pimcp:640 root:pihttp:640' "$(root stat -c '%U:%G:%a' /run/pimcp/mcp.env /run/pihttp/http.env | tr '\n' ' ' | sed 's/ $//')"
# pi-migrate, as root, takes the reader URL from mcp.env: pimcp must not be able to add a line to
# it, nor to http.env, which pihttp, the user that answers the internet, reads.
mustnot 'pimcp cannot write mcp.env' as_pimcp sh -c 'echo PI_DATABASE_URL_ADMIN=postgres://x > /run/pimcp/mcp.env'
mustnot 'nor append to it' as_pimcp sh -c 'echo PI_DATABASE_URL_ADMIN=postgres://x >> /run/pimcp/mcp.env'
mustnot 'nor write http.env' as_pimcp sh -c 'echo PI_DATABASE_URL_ADMIN=postgres://x >> /run/pihttp/http.env'
mustnot 'nor change their modes' as_pimcp chmod 600 /run/pimcp/mcp.env
is 'mcp.env holds the reader URL and the narrowed key file, and nothing else' 'PI_DATABASE_URL_READER=x PI_KEY_FILE=/data/pimcp/keys.json PI_CAPTURE_STORAGE_CEILING_BYTES=x' "$(root sed -E 's/^(PI_DATABASE_URL_READER|PI_CAPTURE_STORAGE_CEILING_BYTES)=.*/\1=x/' /run/pimcp/mcp.env | tr '\n' ' ' | sed 's/ $//')"
mustnot 'no file of /run/pi holds the reader URL' root grep -rq URL_READER /run/pi
mustnot 'pimcp cannot list /run/pi' as_pimcp ls /run/pi
mustnot 'nor /data/pi' as_pimcp ls /data/pi
mustnot 'nor read the key file' as_pimcp cat /data/pi/keys.json
mustnot 'nor admin.env' as_pimcp cat /run/pi/admin.env
mustnot 'pi cannot list /data/pimcp' as_pi ls /data/pimcp
mustnot 'nor read mcp.env' as_pi cat /run/pimcp/mcp.env
mustnot 'pimcp cannot create a file in /run/pimcp' as_pimcp touch /run/pimcp/planted
mustnot 'no sudo rule lets pimcp run anything' sh -c "docker exec -i '$box' setpriv --reuid=pimcp --regid=pimcp --init-groups sudo -n -l 2>&1 | grep -q NOPASSWD"
# extract.env: the pipeline URL, the key file, and of the model, budget and ceiling lines only
# those set, then the key endpoint's override, which this box alone is given.
is 'extract.env holds the pipeline URL, the key file, the extraction model, the decision model, the key ceiling and the override, and no budget line' 'PI_DATABASE_URL_PIPELINE PI_KEY_FILE PI_EXTRACT_MODEL PI_DECIDE_MODEL PI_EXTRACT_KEY_CAP_USD PI_OPENROUTER_KEY_URL' "$(root sed 's/=.*//' /run/pi/extract.env | tr '\n' ' ' | sed 's/ $//')"
must 'and the ceiling in it is the one the service set' root grep -qx "PI_EXTRACT_KEY_CAP_USD=$PI_EXTRACT_KEY_CAP_USD" /run/pi/extract.env
must 'and the pipeline URL in it is the one the service set' root grep -qxF "PI_DATABASE_URL_PIPELINE=$PI_DATABASE_URL_PIPELINE" /run/pi/extract.env
mustnot 'no other file holds the pipeline URL' root grep -q PIPELINE /run/pi/admin.env /run/pi/sync.env /run/pimcp/mcp.env /run/pi/work.env
# work.env: the work URL and the erasure journal's path, and no key file: the tick holds no key.
is "work.env is pi's alone, holds the work URL, the journal path and the tick's state file, and no key file" 'PI_DATABASE_URL_WORK PI_ERASURE_JOURNAL PI_WORK_STATE' "$(root sed 's/=.*//' /run/pi/work.env | grep -vx PI_WORK_SHADOW_TRIGGERS | tr '\n' ' ' | sed 's/ $//')"
must 'and the work URL in it is the one the service set' root grep -qxF "PI_DATABASE_URL_WORK=$PI_DATABASE_URL_WORK" /run/pi/work.env
must 'and the journal is the one beside the key file' root grep -qx 'PI_ERASURE_JOURNAL=/data/pi/keys.json.erasures' /run/pi/work.env
mustnot 'no other file holds the work URL' root grep -q URL_WORK /run/pi/admin.env /run/pi/sync.env /run/pimcp/mcp.env /run/pi/extract.env
must 'the canary secret is in admin.env (a positive control for the checks below)' root grep -qF "$canary" /run/pi/admin.env
must 'admin.env carries PI_RECORD_ENABLED, which clients add and set-tools read' root grep -q '^PI_RECORD_ENABLED=' /run/pi/admin.env
mustnot 'sync.env and mcp.env hold no Google client secret' root grep -q GOOGLE /run/pi/sync.env /run/pimcp/mcp.env
# The drain knows the box's own host from sync.env, the one http.env holds.
is 'sync.env holds the writer URL, the key file and the base URL' 'PI_DATABASE_URL_WRITER PI_KEY_FILE PI_HTTP_BASE_URL' "$(root sed 's/=.*//' /run/pi/sync.env | tr '\n' ' ' | sed 's/ $//')"
is "and the base URL is http.env's" "$(root grep '^PI_HTTP_BASE_URL=' /run/pihttp/http.env)" "$(root grep '^PI_HTTP_BASE_URL=' /run/pi/sync.env)"
# Lens's variables: the ceiling the service set, in the three files that
# read it and no other; the mirror timings and the lane switches, unset, in no file.
is 'the capture ceiling is in admin.env, mcp.env and http.env, as set' 3 "$(root sh -c "grep -lx 'PI_CAPTURE_STORAGE_CEILING_BYTES=$PI_CAPTURE_STORAGE_CEILING_BYTES' /run/pi/admin.env /run/pimcp/mcp.env /run/pihttp/http.env | wc -l")"
mustnot 'and in no other file of /run/pi' root sh -c "grep -l PI_CAPTURE_STORAGE /run/pi/*.env | grep -vx '/run/pi/admin.env'"
mustnot 'unset, the mirror timings and the lane switches are in no file' root grep -qE 'PI_MIRROR_|PI_EXTRACT_MEETINGS|PI_EXTRACT_MOMENTS|PI_EXTRACT_TIME|PI_EXTRACT_OWN_LINES|PI_EXTRACT_SECOND_DEGREE|PI_EXTRACT_REPAIR|PI_EXTRACT_REASK|PI_EXTRACT_FACT_KINDS' /run/pi/admin.env /run/pi/sync.env /run/pimcp/mcp.env /run/pihttp/http.env /run/pi/extract.env /run/pi/work.env
# Unset, extraction's Anthropic key and effort are in no file the box wrote; nor the moment
# lane's model and effort.
# grep exits 1 for no match and 2 for an error, so only 1 passes: a missing directory fails.
must "unset, PI_EXTRACT_ANTHROPIC_KEY, PI_EXTRACT_EFFORT and PI_EXTRACT_MOMENT_* are in no file" root sh -c "grep -rqE 'PI_EXTRACT_ANTHROPIC_KEY|PI_EXTRACT_EFFORT|PI_EXTRACT_MOMENT_' /run/pi /run/reasoner /run/pisend; [ \$? -eq 1 ]"
# The override of the key endpoint, which this box alone is given, is named first: a start that
# holds it says so in one fixed line, for the host's logs to show (HO5). No schema yet, so the
# start's import of the model key fails, and says so next. A variable left unset is named between
# them, at level info, and is no part of this.
is 'the container log starts with the entrypoint lines' '{"event":"box_start","code":"key_url_override"} {"event":"box_start","code":"model_key_import_failed"}' "$(docker logs "$box" 2>&1 | grep -v '"code":"optional_unset"' | head -n 2 | untimed | tr '\n' ' ' | sed 's/ $//')"
is 'the override is named once, by its code alone' 1 "$(docker logs "$box" 2>&1 | grep -c key_url_override)"
mustnot 'and its value is in no line of the log' sh -c "docker logs '$box' 2>&1 | grep -qF '$keyurl'"
is 'the model key file is pi-only' pi:600 "$(root stat -c '%U:%a' /run/pi/model-key.env)"
must 'after a failed import the model key is in model-key.env (the positive control)' root grep -qF "$modelkey" /run/pi/model-key.env
mustnot 'and in no other file of /run/pi' root sh -c "grep -lF '$modelkey' /run/pi/* | grep -vx /run/pi/model-key.env"
# No key file yet, so the timer's first sync fails: a positive control for the line below.
must 'a sync that fails is one fixed line on the box output, with its exit status' wait_for 30 box_failed sync_timer_failed exit_1
# And the settle after it fails too, for the same reason.
must 'the settle after every sync runs, and a settle that fails is one fixed line on the box output' wait_for 30 box_failed settle_timer_failed exit_1
must 'and the container log holds nothing but fixed lines' only_fixed_lines
mustnot 'with no extract-on the timer starts no extract' root test -e /data/pi/extract.log
# The proposal wake: its supervisor runs as pi, and with no extract-on a wake
# starts nothing, writes no extract log and exits 3, which the listener logs as `held`.
must 'the wake supervisor runs, as pi' root sh -c "for p in /proc/[0-9]*; do case \$(tr '\0' ' ' < \$p/cmdline 2> /dev/null) in *'/usr/local/lib/pi/supervise wake '*) [ \"\$(stat -c %U \$p)\" = pi ] && exit 0 ;; esac; done; exit 1"
is 'with no extract-on a wake is held' 3 "$(as_pi sh -c '/usr/local/lib/pi/wake-run; echo $?')"
mustnot 'and starts no extract' root test -e /data/pi/extract.log
# Nor a schema, a journal or a reasoner's token, so the tick and the reasoner fail too.
must 'a tick that fails is one fixed line on the box output, with its exit status' wait_for 30 box_failed work_tick_failed exit_1
must 'a reasoner run that fails is one fixed line on the box output, with its exit status' wait_for 60 box_failed reasoner_failed exit_1
must 'and the container log still holds nothing but fixed lines' only_fixed_lines
is 'the work log is pi-only: the timer wrote it as pi' pi:600 "$(root stat -c '%U:%a' /data/pi/work.log)"
mustnot 'the image makes no erasure journal' root test -e /data/pi/keys.json.erasures
# The reasoner's file, in a directory root owns and the reasoner reads.
is '/run/reasoner is root:reasoner, mode 750' 'root:reasoner 750' "$(root stat -c '%U:%G %a' /run/reasoner)"
mustnot 'the reasoner user cannot create a file in it' as_reasoner touch /run/reasoner/planted
must 'root can (the positive control)' root sh -c 'touch /run/reasoner/planted && rm /run/reasoner/planted'
is "reasoner.env is the reasoner's alone" reasoner:600 "$(root stat -c '%U:%a' /run/reasoner/reasoner.env)"
is 'it holds the model, its key, its ceiling and the override, and nothing else' 'PI_REASONER_MODEL PI_REASONER_MODEL_KEY PI_REASONER_KEY_CAP_USD PI_OPENROUTER_KEY_URL' "$(root sed 's/=.*//' /run/reasoner/reasoner.env | tr '\n' ' ' | sed 's/ $//')"
must 'and the ceiling in it is the one the service set' root grep -qx "PI_REASONER_KEY_CAP_USD=$PI_REASONER_KEY_CAP_USD" /run/reasoner/reasoner.env
must 'and the key in it is the one the service set' root grep -qxF "PI_REASONER_MODEL_KEY=$reasonerkey" /run/reasoner/reasoner.env
must 'the reasoner reads it (the positive control)' as_reasoner grep -qF "$reasonerkey" /run/reasoner/reasoner.env
mustnot 'pi cannot read it' as_pi cat /run/reasoner/reasoner.env
mustnot "pi's files hold no PI_REASONER name" root grep -q PI_REASONER /run/pi/admin.env /run/pi/sync.env /run/pimcp/mcp.env /run/pi/extract.env /run/pi/work.env /run/pi/model-key.env
mustnot 'no file of /run/pi holds the reasoner key' root grep -rqF "$reasonerkey" /run/pi
mustnot 'nothing names PI_REASONER_ZDR' root grep -rq PI_REASONER_ZDR /run/pi /run/reasoner /usr/local/bin /usr/local/lib/pi
# The send user's file, in a directory root owns and pisend reads.
is '/run/pisend is root:pisend, mode 750' 'root:pisend 750' "$(root stat -c '%U:%G %a' /run/pisend)"
is "send.env is pisend's alone" pisend:600 "$(root stat -c '%U:%a' /run/pisend/send.env)"
is 'it holds the proxy URL and the send client, and nothing else' 'PI_DATABASE_URL_PROXY PI_SEND_GOOGLE_CLIENT_ID PI_SEND_GOOGLE_CLIENT_SECRET' "$(root sed 's/=.*//' /run/pisend/send.env | tr '\n' ' ' | sed 's/ $//')"
must 'and the URL in it is the one the service set' root grep -qxF "PI_DATABASE_URL_PROXY=$PI_DATABASE_URL_PROXY" /run/pisend/send.env
must 'and the secret' root grep -qxF "PI_SEND_GOOGLE_CLIENT_SECRET=$sendsecret" /run/pisend/send.env
mustnot 'no copy of the key file or the journal is there before a send' root sh -c 'test -e /run/pisend/keys.json || test -e /run/pisend/keys.json.erasures'
mustnot 'no file of /run/pi or /run/reasoner names a send variable' root grep -rqE '^(PI_DATABASE_URL_PROXY|PI_SEND_)' /run/pi /run/reasoner
mustnot 'nor holds the proxy password or the send secret' root grep -rqF -e "$proxypw" -e "$sendsecret" /run/pi /run/reasoner
mustnot 'pisend cannot create a file in /run/pisend' as_pisend touch /run/pisend/planted
must 'root can (the positive control)' root sh -c 'touch /run/pisend/planted && rm /run/pisend/planted'
# S10: recorded, not asserted. A container's /run is its own writable layer unless the host mounts
# memory there; either way it is not the volume.
echo "# /run is $(root stat -f -c %T /run) (S10, recorded)"
# The network: the box reaches its database and the fake key endpoint, and nothing outside.
reach() { root node -e 'const s = require("node:net").connect(Number(process.argv[2]), process.argv[1]); s.setTimeout(5000, () => process.exit(1)); s.on("connect", () => process.exit(0)); s.on("error", () => process.exit(1));' "$1" "$2"; }
must 'the box reaches its database (the positive control)' reach "$pg" 5432
must 'and the fake key endpoint on its own loopback' reach 127.0.0.1 8787
mustnot 'and no address outside: it has no way out' reach 1.1.1.1 443
mustnot 'nor a name it would look up' reach openrouter.ai 443
# The restricted reader's URL, in a directory root owns and pirestricted alone reads.
is '/run/pirestricted is root:pirestricted, mode 750' 'root:pirestricted 750' "$(root stat -c '%U:%G %a' /run/pirestricted)"
is "restricted.env is pirestricted's alone" pirestricted:600 "$(root stat -c '%U:%a' /run/pirestricted/restricted.env)"
is 'it holds the restricted URL and nothing else' PI_DATABASE_URL_RESTRICTED "$(root sed 's/=.*//' /run/pirestricted/restricted.env | tr '\n' ' ' | sed 's/ $//')"
must 'and the URL in it is the one the service set' root grep -qxF "PI_DATABASE_URL_RESTRICTED=$PI_DATABASE_URL_RESTRICTED" /run/pirestricted/restricted.env
mustnot 'pi cannot read it' as_pi cat /run/pirestricted/restricted.env
mustnot 'no file of /run/pi holds the restricted URL' root grep -rq URL_RESTRICTED /run/pi
# The work-notice sender's file, in a directory root
# owns and pinotify alone reads, and its directory on the volume.
is 'pinotify has fixed ids, no home and no shell' 'pinotify 904 904 /nonexistent /usr/sbin/nologin' "$(root getent passwd pinotify | awk -F: '{print $1, $3, $4, $6, $7}')"
is 'pinotify is in its own group alone, not in pi' pinotify "$(root id -nG pinotify)"
mustnot 'no sudo rule names pinotify, pi-notify or its loader' root grep -rqE 'pinotify|pi-notify|notify-run|notify-serve' /etc/sudoers /etc/sudoers.d
is 'pi-notify is root-owned, mode 700, and its loader and supervisor root-owned, mode 755' 'root:700 root:755 root:755' "$(root stat -c '%U:%a' /usr/local/bin/pi-notify /usr/local/lib/pi/notify-run /usr/local/lib/pi/notify-serve | tr '\n' ' ' | sed 's/ $//')"
is '/data/pinotify is pinotify:pinotify, mode 700' 'pinotify:pinotify 700' "$(root stat -c '%U:%G %a' /data/pinotify)"
is '/run/pinotify is root:pinotify, mode 750' 'root:pinotify 750' "$(root stat -c '%U:%G %a' /run/pinotify)"
is "notify.env is pinotify's alone" pinotify:600 "$(root stat -c '%U:%a' /run/pinotify/notify.env)"
is 'it holds exactly PI_DATABASE_URL_NOTIFY and PI_WEBHOOK_SECRETS' 'PI_DATABASE_URL_NOTIFY PI_WEBHOOK_SECRETS' "$(root sed 's/=.*//' /run/pinotify/notify.env | tr '\n' ' ' | sed 's/ $//')"
must 'and the URL in it is the one the service set' root grep -qxF "PI_DATABASE_URL_NOTIFY=$PI_DATABASE_URL_NOTIFY" /run/pinotify/notify.env
must 'and the key file is /data/pinotify/webhooks.json' root grep -qxF 'PI_WEBHOOK_SECRETS=/data/pinotify/webhooks.json' /run/pinotify/notify.env
# bootstrap.env is made from the files of /run/pi and /run/pirestricted alone, so neither does it.
mustnot 'work.env and every file of /run/pi, /run/pimcp, /run/pisend, /run/reasoner and /run/pirestricted name neither variable nor hold the notify password' root grep -rqE "PI_DATABASE_URL_NOTIFY|PI_WEBHOOK_SECRETS|$notifypw" /run/pi /run/pimcp /run/pisend /run/reasoner /run/pirestricted
must 'pinotify reads notify.env (the positive control)' as_pinotify grep -qF "$notifypw" /run/pinotify/notify.env
for who in as_pi as_pimcp agent as_reasoner as_pisend; do
  mustnot "$who cannot read notify.env" "$who" cat /run/pinotify/notify.env
  mustnot "$who cannot list /data/pinotify" "$who" ls /data/pinotify
done
# Its supervisor runs as pinotify and logs to pinotify's own file; until pi-migrate the sender
# cannot log in, and is started again.
notify_supervised() { root sh -c "for p in /proc/[0-9]*; do case \$(tr '\0' ' ' < \$p/cmdline 2> /dev/null) in *'/usr/local/lib/pi/supervise notify '*) [ \"\$(stat -c %U \$p)\" = pinotify ] && exit 0 ;; esac; done; exit 1"; }
must 'the notify supervisor runs, as pinotify' notify_supervised
must 'and logs to /data/pinotify/notify.log, which is pinotify:600' wait_for 30 sh -c "[ \"\$(docker exec '$box' stat -c '%U:%a' /data/pinotify/notify.log)\" = pinotify:600 ] && docker exec '$box' grep -q '\"event\":\"notify_start\"' /data/pinotify/notify.log"
is 'pirestricted is in its own group alone, not in pi' pirestricted "$(root id -nG pirestricted)"

echo '# Tailscale'
# Its network is internal, so the node never reaches Tailscale's control server: tailscale up
# waits, no login link is printed and nothing is served. What is checked is who runs it and what
# it reaches.
is 'pitail has fixed ids, no home and no shell' 'pitail 905 905 /nonexistent /usr/sbin/nologin' "$(root getent passwd pitail | awk -F: '{print $1, $3, $4, $6, $7}')"
is 'pitail is in its own group and piweb, not in pi' 'pitail piweb' "$(root id -nG pitail)"
is 'piweb is gid 906, with pitail its one member' 'piweb:906:pitail' "$(root getent group piweb | cut -d: -f1,3,4)"
is 'pi is not in piweb: its other processes never hold it' pi "$(root id -nG pi)"
mustnot 'no sudo rule names pitail, piweb or Tailscale' root grep -rqiE 'pitail|piweb|tailscale' /etc/sudoers /etc/sudoers.d
is 'tailscale, tailscaled, the two supervisors and tail-config are root-owned, mode 755' 'root:755 root:755 root:755 root:755 root:755' "$(root stat -c '%U:%a' /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/lib/pi/tail-serve /usr/local/lib/pi/tail-config /usr/local/lib/pi/web-serve | tr '\n' ' ' | sed 's/ $//')"
is 'Tailscale is the pinned version' 1.104.4 "$(root tailscale version | head -n 1)"
is "/data/pitail and /run/pitail are pitail's alone, mode 700" 'pitail:pitail 700 pitail:pitail 700' "$(root stat -c '%U:%G %a' /data/pitail /run/pitail | tr '\n' ' ' | sed 's/ $//')"
# Matched at its end, with its flags: userspace networking, its state and socket in their places,
# and no log upload.
tailscaled_pid() { root sh -c "for p in /proc/[0-9]*; do case \$(tr '\0' ' ' < \$p/cmdline 2> /dev/null) in *'/usr/local/bin/tailscaled --tun=userspace-networking --statedir=/data/pitail --socket=/run/pitail/tailscaled.sock --no-logs-no-support ') echo \${p#/proc/}; exit 0 ;; esac; done; exit 1"; }
must 'tailscaled runs in userspace networking, its state and socket in their places' wait_for 30 tailscaled_pid
tpid=$(tailscaled_pid)
is 'as pitail' pitail "$(root stat -c %U "/proc/$tpid")"
# The shell that starts it adds PWD and OLDPWD, as it does for every supervised process.
is 'with the path in its environment and nothing else but the shell'"'"'s working directory' 'OLDPWD PATH PWD' "$(as_pitail sh -c "tr '\0' '\n' < /proc/$tpid/environ" | sed 's/=.*//' | sort | tr '\n' ' ' | sed 's/ $//')"
# By each process's command line, matched at its start, so the check's own shell ("sh -c ...") is
# not counted. Root cannot read another user's /proc/PID/exe without the ptrace capability.
tailscale_as() { root sh -c 'for p in /proc/[0-9]*; do case $(tr "\0" " " < "$p/cmdline" 2> /dev/null) in /usr/local/bin/tailscale*) [ "$(stat -c %U "$p")" = "$1" ] && exit 0 ;; esac; done; exit 1' tailscale_as "$1"; }
must 'Tailscale runs as pitail (the positive control)' tailscale_as pitail
mustnot 'and no Tailscale process runs as root' tailscale_as root
must "tailscaled's local API socket is in /run/pitail" root test -S /run/pitail/tailscaled.sock
prefs() { as_pitail /usr/local/bin/tailscale --socket=/run/pitail/tailscaled.sock debug prefs; }
has_pref() { prefs | grep -qF "$1"; }
must 'pitail reaches the daemon (the positive control)' prefs
# With no way out, `up` waits to its timeout of 90 seconds and is tried again a minute later, so a
# loaded machine can take that long to show its settings.
must 'tail-serve ran tailscale up with its settings' wait_for 180 has_pref '"Hostname": "pi-box"'
must 'Tailscale SSH is off' has_pref '"RunSSH": false'
is 'nothing is served before the login, through Funnel or otherwise' '{}' "$(as_pitail /usr/local/bin/tailscale --socket=/run/pitail/tailscaled.sock serve status --json)"
mustnot 'and no installed script of the box turns Funnel on' root grep -rqiE 'tailscale funnel|ts funnel|--funnel|allowfunnel' /usr/local/lib/pi
for who in agent as_pi as_pimcp as_pihttp as_reasoner as_pisend as_pinotify; do
  mustnot "$who cannot reach the daemon" "$who" /usr/local/bin/tailscale --socket=/run/pitail/tailscaled.sock debug prefs
  mustnot "$who cannot list /run/pitail" "$who" ls /run/pitail
  mustnot "$who cannot list /data/pitail" "$who" ls /data/pitail
done
must "tailscaled keeps its state on the volume, pitail's alone" wait_for 30 sh -c "[ \"\$(docker exec '$box' stat -c '%U:%a' /data/pitail/tailscaled.state)\" = pitail:600 ]"
mustnot 'pitail cannot list /data/pi' as_pitail ls /data/pi
must 'but reaches a name in it (the positive control): a missing one is missing, not refused' as_pitail sh -c 'stat /data/pi/nothing-here 2>&1 | grep -q "No such file"'
for path in /run/pi /run/pimcp /run/reasoner /run/pisend /run/pinotify /run/pirestricted /data/agent /data/pinotify /data/pimcp /run/pihttp /data/pihttp; do
  mustnot "pitail cannot list $path" as_pitail ls "$path"
done

echo '# the setup'
must 'pi-admin keys init' root pi-admin keys init --compartments own
is 'the key file is pi-only' pi:600 "$(root stat -c '%U:%a' /data/pi/keys.json)"
settings=$(printf '\n%s\n' "$super" | root pi-db-init 2> /dev/null | tr '\n' ' ' | sed 's/ $//')
case $settings in
  'server_version = 18.'*' log_min_error_statement = panic log_parameter_max_length = 0 log_parameter_max_length_on_error = 0 log_statement = none') ok 'pi-db-init sets the logging settings, and prints them and the version' ;;
  *) no "pi-db-init sets the logging settings, and prints them and the version (got '$settings')" ;;
esac
must 'pi-db-init can run again' sh -c "printf 'postgres\n%s\n' '$super' | docker exec -i '$box' pi-db-init"
proxy_login() { root psql -w -Atc 'select 1' "$PI_DATABASE_URL_PROXY"; }
# The password as SQL finds it without the smoke's own statements holding it: hex of its bytes.
proxypw_sql="convert_from(decode('$(printf '%s' "$proxypw" | od -An -tx1 | tr -d ' \n')', 'hex'), 'UTF8')"
mustnot 'before pi-migrate nothing logs in as pi_proxy with the URL in send.env' proxy_login
notify_login() { root psql -w -Atc 'select 1' "$PI_DATABASE_URL_NOTIFY"; }
notifypw_sql="convert_from(decode('$(printf '%s' "$notifypw" | od -An -tx1 | tr -d ' \n')', 'hex'), 'UTF8')"
mustnot 'before pi-migrate nothing logs in as pi_notify with the URL in notify.env' notify_login
migrate_keep
is 'pi-migrate succeeds, and ends by saying the bootstrap role cannot log in' 'bootstrap can log in: false 0' "$(printf '%s\n' "$migrated" | tail -n 1) $migrated_status"
case $migrated in *'roles: as expected'*) ok "and it found the server's roles as expected" ;; *) no "and it found the server's roles as expected" ;; esac
case $migrated in *'proxy password: set'*) ok "and it set the send role's password" ;; *) no "and it set the send role's password" ;; esac
is 'after it pi_proxy logs in with the password in its URL' 1 "$(proxy_login 2> /dev/null)"
is "the server stores a verifier for pi_proxy, not the password" 't f' "$(docker exec "$pg" psql -U postgres -Atc "select rolpassword like 'SCRAM-SHA-256\$%', strpos(rolpassword, $proxypw_sql) > 0 from pg_authid where rolname = 'pi_proxy'" | tr '|' ' ')"
case $migrated in *'notify password: set'*) ok "and it set the notify role's password" ;; *) no "and it set the notify role's password" ;; esac
is 'after it pi_notify logs in with the password in its URL' 1 "$(notify_login 2> /dev/null)"
is "the server stores a verifier for pi_notify, not the password" 't f' "$(docker exec "$pg" psql -U postgres -Atc "select rolpassword like 'SCRAM-SHA-256\$%', strpos(rolpassword, $notifypw_sql) > 0 from pg_authid where rolname = 'pi_notify'" | tr '|' ' ')"
is 'the migration made the pipeline role, which can log in' t "$(docker exec "$pg" psql -U postgres -Atc "select rolcanlogin from pg_roles where rolname = 'pi_pipeline'")"
is 'pi-migrate makes pi_work, which can log in with the password in its URL' 1 "$(as_pi psql -w -Atc 'select 1' "$PI_DATABASE_URL_WORK" 2> /dev/null)"
is 'pi-migrate makes pi_restricted, which can log in with the password in its URL' 1 "$(root psql -w -Atc 'select 1' "$PI_DATABASE_URL_RESTRICTED" 2> /dev/null)"
is 'after it the bootstrap role cannot log in' f "$(docker exec "$pg" psql -U postgres -Atc "select rolcanlogin from pg_roles where rolname = 'pi_bootstrap'")"
is 'and has no password' t "$(docker exec "$pg" psql -U postgres -Atc "select rolpassword is null from pg_authid where rolname = 'pi_bootstrap'")"
mustnot 'and bootstrap.env is gone' root test -e /run/pi/bootstrap.env
must 'pi-migrate can run again' sh -c "printf 'postgres\n%s\n' '$super' | docker exec -i '$box' pi-migrate"
mustnot 'pi-migrate with a wrong superuser password fails' sh -c "printf 'postgres\nwrong\n' | docker exec -i '$box' pi-migrate"
# The restricted role's password is the owner's to set, so a migration never waits on it:
# with the URL it says it set the password, and without it it says it skipped it
# and still succeeds, ending with the bootstrap role unable to log in.
restricted_out=$(printf 'postgres\n%s\n' "$super" | root pi-migrate 2> /dev/null); restricted_status=$?
is 'with the restricted URL pi-migrate says it set the role password' 'set bootstrap can log in: false 0' "$(printf '%s\n' "$restricted_out" | grep -qx 'restricted password: set' && printf set) $(printf '%s\n' "$restricted_out" | tail -n 1) $restricted_status"
root mv /run/pirestricted/restricted.env /run/pi-root/restricted-env.kept
restricted_out=$(printf 'postgres\n%s\n' "$super" | root pi-migrate 2> /dev/null); restricted_status=$?
is 'with no restricted URL pi-migrate skips the password and still succeeds' 'skipped bootstrap can log in: false 0' "$(printf '%s\n' "$restricted_out" | grep -qx 'restricted password: skipped' && printf skipped) $(printf '%s\n' "$restricted_out" | tail -n 1) $restricted_status"
is 'and the role keeps the password it had' 1 "$(root psql -w -Atc 'select 1' "$PI_DATABASE_URL_RESTRICTED" 2> /dev/null)"
root mv /run/pi-root/restricted-env.kept /run/pirestricted/restricted.env
# pi-migrate takes the reader URL alone from mcp.env, and the restricted URL alone from
# restricted.env: an admin URL with another password, as a user that could write either file
# would add, must not set pi_admin's password. Root plays that user, and puts each file back.
root sh -c 'cp -p /run/pimcp/mcp.env /run/pi-root/mcp-env.kept && cp -p /run/pirestricted/restricted.env /run/pi-root/restricted-env.kept && echo "PI_DATABASE_URL_ADMIN=postgres://pi_admin:smoke-planted@x:5432/pi" | tee -a /run/pimcp/mcp.env >> /run/pirestricted/restricted.env'
is 'with an admin URL planted in mcp.env and restricted.env, pi-migrate still succeeds' 'bootstrap can log in: false 0' "$(migrate_result)"
root sh -c 'cat /run/pi-root/mcp-env.kept > /run/pimcp/mcp.env && cat /run/pi-root/restricted-env.kept > /run/pirestricted/restricted.env && rm /run/pi-root/mcp-env.kept /run/pi-root/restricted-env.kept'
is 'and pi_admin keeps the password in its own URL' 1 "$(root psql -w -Atc 'select 1' "$PI_DATABASE_URL_ADMIN" 2> /dev/null)"
must 'pi-admin status' root pi-admin status
must 'pia is pi-admin' root pia status

echo "# the send role's password"
# S14. pi-migrate sets it from send.env, as a verifier; with no URL it leaves the role as it is,
# and a URL that names another user or a password the laptop loop does not make is refused.
pgsuper() { docker exec "$pg" psql -U postgres -Atc "$1" postgres; }
is 'no session of the server holds the proxy password in its statement' 0 "$(pgsuper "select count(*) from pg_stat_activity where strpos(query, $proxypw_sql) > 0")"
is "and the server's log does not hold it" 0 "$(docker logs "$pg" 2>&1 | grep -cF "$proxypw")"
pgsuper 'alter role pi_proxy password null' > /dev/null
mustnot 'with its password taken away pi_proxy cannot log in (the positive control)' proxy_login
# send.env changed for one run, then put back. Root keeps the original in its own directory.
send_env_as() { root sh -c 'cp -p /run/pisend/send.env /run/pi-root/send-env.kept && { grep -v "^PI_DATABASE_URL_PROXY=" /run/pi-root/send-env.kept; cat; } > /run/pisend/send.env'; }
send_env_back() { root sh -c 'cat /run/pi-root/send-env.kept > /run/pisend/send.env && rm /run/pi-root/send-env.kept'; }
: | send_env_as
migrate_keep
is 'with no proxy URL in send.env pi-migrate skips the password and still succeeds' 'proxy password: skipped|bootstrap can log in: false 0' "$(printf '%s\n' "$migrated" | tail -n 2 | tr '\n' '|' | sed 's/|$//') $migrated_status"
case $migrated in *'restricted password: set'*) ok "and it still says the restricted role's password status" ;; *) no "and it still says the restricted role's password status" ;; esac
mustnot 'and pi_proxy still cannot log in' proxy_login
send_env_back
for bad in "postgres://pi_admin:$proxypw@$pg:5432/pi" "postgres://pi_proxy:${proxypw%?}@$pg:5432/pi" "postgres://pi_proxy:A${proxypw#?}@$pg:5432/pi" "postgres://pi_proxy:${proxypw%?}g@$pg:5432/pi" "postgres://pi_proxy:$proxypw@$pg:5432/pi?host=elsewhere"; do
  printf '%s\n' "PI_DATABASE_URL_PROXY=$bad" | send_env_as
  migrate_keep
  is 'a URL naming another user, a password that is not 64 lower-case hex, or a query, makes pi-migrate refuse and exit 1, ending with the bootstrap unable to log in' 'proxy password: refused|bootstrap can log in: false 1' "$(printf '%s\n' "$migrated" | tail -n 2 | tr '\n' '|' | sed 's/|$//') $migrated_status"
  send_env_back
done
mustnot 'and pi_proxy still cannot log in' proxy_login
is 'pi-migrate sets it again from send.env' 'bootstrap can log in: false 0' "$(migrate_result)"
is 'and pi_proxy logs in' 1 "$(proxy_login 2> /dev/null)"

echo "# the notify role's password"
# As the send role's above: from notify.env, as a verifier made as pinotify;
# with no URL skipped while the migration goes on; a URL naming another user, a password the laptop
# loop does not make, or a query, refused.
is 'no session of the server holds the notify password in its statement' 0 "$(pgsuper "select count(*) from pg_stat_activity where strpos(query, $notifypw_sql) > 0")"
is "and the server's log does not hold it" 0 "$(docker logs "$pg" 2>&1 | grep -cF "$notifypw")"
pgsuper 'alter role pi_notify password null' > /dev/null
mustnot 'with its password taken away pi_notify cannot log in (the positive control)' notify_login
notify_env_as() { root sh -c 'cp -p /run/pinotify/notify.env /run/pi-root/notify-env.kept && { grep -v "^PI_DATABASE_URL_NOTIFY=" /run/pi-root/notify-env.kept; cat; } > /run/pinotify/notify.env'; }
notify_env_back() { root sh -c 'cat /run/pi-root/notify-env.kept > /run/pinotify/notify.env && rm /run/pi-root/notify-env.kept'; }
: | notify_env_as
migrate_keep
case $migrated in *'notify password: skipped'*) ok 'with no notify URL in notify.env pi-migrate skips the password' ;; *) no 'with no notify URL in notify.env pi-migrate skips the password' ;; esac
is 'and still succeeds' 'bootstrap can log in: false 0' "$(printf '%s\n' "$migrated" | tail -n 1) $migrated_status"
mustnot 'and pi_notify still cannot log in' notify_login
notify_env_back
for bad in "postgres://pi_proxy:$notifypw@$pg:5432/pi" "postgres://pi_notify:${notifypw%?}@$pg:5432/pi" "postgres://pi_notify:A${notifypw#?}@$pg:5432/pi" "postgres://pi_notify:$notifypw@$pg:5432/pi?host=elsewhere"; do
  printf '%s\n' "PI_DATABASE_URL_NOTIFY=$bad" | notify_env_as
  migrate_keep
  is 'a notify URL naming another user, a password that is not 64 lower-case hex, or a query, makes pi-migrate refuse and exit 1, ending with the bootstrap unable to log in' 'refused bootstrap can log in: false 1' "$(printf '%s\n' "$migrated" | grep -qx 'notify password: refused' && printf refused) $(printf '%s\n' "$migrated" | tail -n 1) $migrated_status"
  # One bad optional URL does not keep the send role's password from being set.
  case $migrated in *'proxy password: set'*) ok 'and pi-migrate still sets the send role password' ;; *) no 'and pi-migrate still sets the send role password' ;; esac
  notify_env_back
done
mustnot 'and pi_notify still cannot log in' notify_login
is 'pi-migrate sets it again from notify.env' 'bootstrap can log in: false 0' "$(migrate_result)"
is 'and pi_notify logs in' 1 "$(notify_login 2> /dev/null)"

echo "# the bootstrap window"
# pi holds the bootstrap's password while the migration runs, so pi-migrate ends every session of
# the role, and checks the server's roles after it. Root plays a pi that opened a session of its own
# and kept it: the superuser gives the role a login for this, as pi-migrate does for its run.
pgsuper "alter role pi_bootstrap login password 'smoke-bootstrap-session'" > /dev/null
docker exec -d "$pg" sh -c "PGPASSWORD=smoke-bootstrap-session psql -h 127.0.0.1 -U pi_bootstrap -d pi -c 'select pg_sleep(600)'"
bootstrap_sessions() { pgsuper "select count(*) from pg_stat_activity where usename = 'pi_bootstrap'"; }
bootstrap_open() { [ "$(bootstrap_sessions)" -ge 1 ]; }
must 'a session of the bootstrap is open before pi-migrate (the positive control)' wait_for 30 bootstrap_open
is 'pi-migrate succeeds beside it' 'bootstrap can log in: false 0' "$(migrate_result)"
is 'and no session of the bootstrap is left' 0 "$(bootstrap_sessions)"
# A role the bootstrap made beside the migration (as its maker, the bootstrap holds it with ADMIN,
# which the superuser plays here) fails the run before the send role's password is set; so does a
# grant that lets a login role act as another, or another role act as the owner. Those two are
# refused earlier, by `db migrate` itself, so the run ends before the check that says its line.
for planted in 'create role pi_planted login admin pi_bootstrap' 'grant pi_proxy to pi_admin' 'grant pi_owner to pi_writer'; do
  pgsuper "$planted" > /dev/null
  migrate_keep
  case $planted in
    create*) refusal='roles: not as expected|bootstrap can log in: false 1' ;;
    *) refusal='bootstrap can log in: false 1' ;;
  esac
  is "with \"$planted\" pi-migrate refuses and exits 1, the bootstrap unable to log in" "$refusal" "$(printf '%s\n' "$migrated" | tail -n 2 | tr '\n' '|' | sed 's/|$//') $migrated_status"
  case $migrated in *'proxy password:'*) no 'and it sets no send role password' ;; *) ok 'and it sets no send role password' ;; esac
  case $planted in create*) ;; *) must 'and it was the grant that refused it' grep -q '"code":"role_attributes"' "$tmp/migrate.err" ;; esac
  case $planted in
    create*) pgsuper 'drop role pi_planted' > /dev/null ;;
    *) pgsuper "$(printf '%s\n' "$planted" | sed 's/^grant \(.*\) to \(.*\)$/revoke \1 from \2/')" > /dev/null ;;
  esac
done
is 'with the planted roles gone pi-migrate succeeds again' 'bootstrap can log in: false 0' "$(migrate_result)"

echo '# the erasure journal and the work tick'
# On a box that has never had an erasure there is no journal, and for the tick a missing journal is
# journal_refused: a wrong path must never read as "no erasure was ever made". The image does not
# make it;
mustnot 'after keys and the schema there is still no journal' root test -e /data/pi/keys.json.erasures
tick_out=$(root pi-work work tick 2>&1); tick_status=$?
is 'with no journal the tick exits 1' 1 "$tick_status"
case $tick_out in *'"code":"journal_refused"'*) ok 'with journal_refused' ;; *) no "with journal_refused (got '$tick_out')" ;; esac
is 'pia erase replay on a store with no erasure applies nothing' '{"applied":0,"journalled":0}' "$(root pia erase replay 2> /dev/null)"
is "and makes the journal, empty and pi's alone" 'pi:pi 600 0' "$(root stat -c '%U:%G %a %s' /data/pi/keys.json.erasures)"
journal_inode=$(root stat -c %i /data/pi/keys.json.erasures)
# pia's last step hands the agent API its narrowed key file and its copy of the journal, as pimcp.
is "and pia hands the agent API its key file and its journal's mark, pimcp's alone" 'pimcp:pimcp 600 pimcp:pimcp 600' "$(root stat -c '%U:%G %a' /data/pimcp/keys.json /data/pimcp/keys.json.erasures | tr '\n' ' ' | sed 's/ $//')"
is "the journal's copy is its mark alone" '{"mark":0}' "$(as_pimcp cat /data/pimcp/keys.json.erasures)"
tick_out=$(root pi-work work tick 2>&1); tick_status=$?
is 'pi-work work tick exits 0 on a migrated database with an empty journal' 0 "$tick_status"
case $tick_out in *'"event":"work_tick"'*) ok 'and logs its work_tick line' ;; *) no "and logs its work_tick line (got '$tick_out')" ;; esac
must 'pia erase replay can run again' root pia erase replay
# The settle the timer runs after every sync, once the keys, the schema
# and the journal exist: it exits 0 with no forget to settle, and prints only its counts.
is "pia erase settle, as the timer runs it, settles nothing and exits 0" '{"settled":0,"alreadyRemoved":0,"failed":0} 0' "$(out=$(root /usr/local/bin/pi-admin erase settle 2> /dev/null); echo "$out $?")"
is 'and leaves the same journal' "$journal_inode 0" "$(root stat -c '%i %s' /data/pi/keys.json.erasures)"
is 'pi-work refuses agent' 'only root and pi run this' "$(agent pi-work work tick 2>&1)"

echo '# google connect, up to the URL it prints: no request is made to Google'
# connect prints its URL and then waits for the browser; the timeout ends it. It is long enough
# for a start under emulation of another architecture, where five seconds was not always.
case $(root timeout 20 pi-admin google connect --account personal --port 8765 2> /dev/null | head -n 1) in
  https://accounts.google.com/*client_id=smoke-client-id*) ok 'pi-admin google connect prints the consent URL for the default client' ;;
  *) no 'pi-admin google connect prints the consent URL for the default client' ;;
esac
printf '%s\n' PI_GOOGLE_CLIENT_ID=smoke-other-id PI_GOOGLE_CLIENT_SECRET=smoke-other-secret | root sh -c 'umask 077; { grep -v "^PI_GOOGLE_" /run/pi/admin.env; cat; } > /run/pi/connect.env; chown pi:pi /run/pi/connect.env'
case $(root timeout 20 /usr/local/lib/pi/as-pi connect google connect --account work --port 8766 2> /dev/null | head -n 1) in
  https://accounts.google.com/*client_id=smoke-other-id*) ok 'a one-off connect.env gives connect another client' ;;
  *) no 'a one-off connect.env gives connect another client' ;;
esac
root rm /run/pi/connect.env

echo '# pi-mcp, before any client token is stored'
ping='{"jsonrpc":"2.0","id":1,"method":"ping"}'
pong='{"jsonrpc":"2.0","id":1,"result":{}}'
init='{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
printf '%s\n' "$ping" | agent /usr/local/bin/pi-mcp > "$tmp/agent.out" 2> "$tmp/agent.err"
must 'as agent, a ping gets exactly one line of JSON on stdout and nothing else' sh -c "printf '%s\n' '$pong' | cmp -s - '$tmp/agent.out'"
mustnot 'and stderr holds only event lines' grep -qv '^{"event"' "$tmp/agent.err"
printf '%s\n' "$ping" | root /usr/local/bin/pi-mcp > "$tmp/root.out" 2> "$tmp/root.err"
must 'as root (the bridge), the same' sh -c "printf '%s\n' '$pong' | cmp -s - '$tmp/root.out'"
mustnot 'and stderr holds only event lines' grep -qv '^{"event"' "$tmp/root.err"
is 'with no token stored, initialize is answered unauthorized' '{"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"unauthorized"}}' "$(printf '%s\n' "$init" | agent /usr/local/bin/pi-mcp 2> /dev/null)"
printf '%s\n' "$ping" | agent /usr/local/bin/pi-mcp extra > /dev/null 2>&1
is 'pi-mcp refuses an argument' 2 $?

echo '# clients and their tokens'
must 'a first client for agent, with one tool' root sh -c 'pi-admin clients add smoke-first --views self --tools get_self --runtime local | pi-token agent'
list='{"jsonrpc":"2.0","id":3,"method":"tools/list"}'
tools() { grep -o '"name":"[a-z_]*"' | wc -l | tr -d ' '; }
is 'agent is served as that client' 1 "$(printf '%s\n' "$list" | agent /usr/local/bin/pi-mcp 2> /dev/null | tools)"
# The second token replaces the first: the check further down sees four tools, not one.
must 'a client for agent, its token piped to pi-token and never shown' root sh -c 'pi-admin clients add smoke-box --views self,people --tools get_self,search,get_entity,get_timeline --runtime local | pi-token agent'
must 'a client for the bridge, with one tool, so the two can be told apart' root sh -c 'pi-admin clients add smoke-bridge --views self --tools get_self --runtime local | pi-token root'
is "each token file is pimcp's alone" 'pimcp:600 pimcp:600' "$(root stat -c '%U:%a' /data/pimcp/tokens/agent /data/pimcp/tokens/root | tr '\n' ' ' | sed 's/ $//')"
mustnot 'pi-token refuses input that is no token' root sh -c 'echo nothing | pi-token agent'
case $(printf '%s\n' "$init" | agent /usr/local/bin/pi-mcp 2> /dev/null) in
  *'"protocolVersion":"2025-06-18"'*) ok 'as agent, initialize answers with the protocol version' ;;
  *) no 'as agent, initialize answers with the protocol version' ;;
esac
case $(printf '%s\n' "$init" | root /usr/local/bin/pi-mcp 2> /dev/null) in
  *'"protocolVersion":"2025-06-18"'*) ok 'as root (the bridge), the same' ;;
  *) no 'as root (the bridge), the same' ;;
esac
# How many tools the caller's client holds: 4 for agent's, 1 for the bridge's.
is "the new token replaced the old one: agent is served as agent's client" 4 "$(printf '%s\n' "$list" | agent /usr/local/bin/pi-mcp 2> /dev/null | tools)"
is "root is served as the bridge's client" 1 "$(printf '%s\n' "$list" | root /usr/local/bin/pi-mcp 2> /dev/null | tools)"

echo '# pi http'
# GET PATH over the box's loopback, as the bridge's client when a second argument is given; the
# token is read from its file inside node, so it is never an argument. Prints the status and body.
http_get() { root node -e 'const [path, who] = process.argv.slice(1); const headers = who ? { authorization: `Bearer ${require("node:fs").readFileSync(`/data/pimcp/tokens/${who}`, "utf8").trim()}` } : {}; fetch(`http://127.0.0.1:8080${path}`, { headers }).then(async (r) => process.stdout.write(`${r.status} ${await r.text()}`), () => process.exit(1))' "$@"; }
# http_is EXPECTED PATH: http_get PATH printed EXPECTED.
http_is() { [ "$(http_get "$2")" = "$1" ]; }
# pi http cannot start before pia first hands pihttp its key file, after the migration, so its
# supervisor may be in its longest wait, five minutes.
must 'pi http binds and /healthz answers' wait_for 330 http_is '200 ok' /healthz
is '/healthz answers ok and nothing else' '200 ok' "$(http_get /healthz)"
is "http.env is root's, read by pihttp's group alone" 'root:pihttp:640' "$(root stat -c '%U:%G:%a' /run/pihttp/http.env)"
must 'with the endpoint on and no trusted proxy, the start says so' start_code "$box" http_trust_proxy_unset
is 'http.env holds the reader URL, the key file, the port, the hold path, the base URL and the capture ceiling, and no token' 'PI_DATABASE_URL_READER PI_KEY_FILE PI_HTTP_PORT PI_READ_HOLD PI_HTTP_BASE_URL PI_CAPTURE_STORAGE_CEILING_BYTES' "$(root sed 's/=.*//' /run/pihttp/http.env | tr '\n' ' ' | sed 's/ $//')"
is 'with no token, the tools are refused' '403 {"error":"not_permitted"}' "$(http_get /v1/tools)"
is "with the bridge's token, its one tool is listed" 1 "$(http_get /v1/tools root | tools)"
case $(root sh -c 'for p in /proc/[0-9]*; do [ "$(stat -c %U "$p")" = pihttp ] && tr "\0" " " < "$p/cmdline"; echo; done' 2> /dev/null) in
  *'main.ts http '*) ok 'pi http runs as pihttp' ;;
  *) no 'pi http runs as pihttp' ;;
esac
case $(root sh -c 'for p in /proc/[0-9]*; do [ "$(stat -c %U "$p")" = pimcp ] && tr "\0" " " < "$p/cmdline"; echo; done' 2> /dev/null) in
  *'main.ts http '*) no 'and not as pimcp' ;;
  *) ok 'and not as pimcp' ;;
esac
must 'and logs to /data/pihttp/http.log' root grep -q '"event":"http_listening"' /data/pihttp/http.log
# pihttp holds what a request needs and nothing of pimcp's: no box client's token, and not the
# stdio endpoint's key copy, which the reasoner's clearance widens.
is 'pihttp has fixed ids, no home and no shell' 'pihttp 908 908 /nonexistent /usr/sbin/nologin' "$(root getent passwd pihttp | awk -F: '{print $1, $3, $4, $6, $7}')"
is 'pihttp is in its own group alone' pihttp "$(root id -nG pihttp)"
is '/run/pihttp is root:pihttp, mode 750, and /data/pihttp pihttp:pihttp, mode 700' 'root:pihttp 750 pihttp:pihttp 700' "$(root stat -c '%U:%G %a' /run/pihttp /data/pihttp | tr '\n' ' ' | sed 's/ $//')"
is "pia hands pihttp its own key file and journal's mark, pihttp's alone" 'pihttp:pihttp 600 pihttp:pihttp 600' "$(root stat -c '%U:%G %a' /data/pihttp/keys.json /data/pihttp/keys.json.erasures | tr '\n' ' ' | sed 's/ $//')"
mustnot 'pihttp cannot list /data/pimcp' as_pihttp ls /data/pimcp
mustnot "nor read the reasoner's token" as_pihttp cat /data/pimcp/tokens/reasoner
mustnot "nor the bridge's" as_pihttp cat /data/pimcp/tokens/root
mustnot "nor pimcp's key copy" as_pihttp cat /data/pimcp/keys.json
mustnot 'nor list /run/pimcp' as_pihttp ls /run/pimcp
mustnot 'nor list /data/pi' as_pihttp ls /data/pi
mustnot 'nor write http.env' as_pihttp sh -c 'echo PI_DATABASE_URL_ADMIN=postgres://x >> /run/pihttp/http.env'
mustnot 'pimcp cannot list /data/pihttp' as_pimcp ls /data/pihttp
mustnot 'no sudo rule lets pihttp run anything' sh -c "docker exec -i '$box' setpriv --reuid=pihttp --regid=pihttp --init-groups sudo -n -l 2>&1 | grep -q NOPASSWD"
root pi-read-hold on
# Under the hold the port is not left empty: lib/held-answer answers every route 503, reading nothing.
must 'the read hold ends pi http, and its port answers unavailable, /healthz included' wait_for 30 http_is '503 {"error":"unavailable"}' /healthz
is "and a tool route the same, with the bridge's token" '503 {"error":"unavailable"}' "$(http_get /v1/tools root)"
case $(root sh -c 'for p in /proc/[0-9]*; do [ "$(stat -c %U "$p")" = pihttp ] && tr "\0" " " < "$p/cmdline"; echo; done' 2> /dev/null) in
  *'main.ts http '*) no 'no pi http runs under the hold' ;;
  *) ok 'no pi http runs under the hold' ;;
esac
root pi-read-hold off
# Its supervisor may be in its longest wait, as at the first start.
must 'and once it is cleared pi http starts again' wait_for 330 http_is '200 ok' /healthz
is 'pi-mcp started by the reasoner answers unauthorized before pi-token reasoner' '{"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"unauthorized"}}' "$(printf '%s\n' "$init" | as_reasoner /usr/local/bin/pi-mcp 2> /dev/null)"
must 'a client for the reasoner, its token piped to pi-token' root sh -c 'pi-admin clients add smoke-reasoner --kind reasoner --views self,people,work --tools get_self,next_run,append_step,finish_run --runtime local | pi-token reasoner'
case $(printf '%s\n' "$init" | as_reasoner /usr/local/bin/pi-mcp 2> /dev/null) in
  *'"protocolVersion":"2025-06-18"'*) ok 'and a result after' ;;
  *) no 'and a result after' ;;
esac
# Only a reasoner's client may take a run: with none queued, next_run answers no run.
next_run='{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"next_run","arguments":{"requestId":"a5c4d1f6-0b1e-4c0e-9a51-6f1d2c3b4a59"}}}'
case $(printf '%s\n' "$next_run" | as_reasoner /usr/local/bin/pi-mcp 2> /dev/null) in
  *'"structuredContent":{"run":null}'*) ok "the reasoner is served as the reasoner's client: next_run answers no run" ;;
  *) no "the reasoner is served as the reasoner's client: next_run answers no run" ;;
esac
mustnot "agent's client may not take a run" sh -c "printf '%s\\n' '$next_run' | docker exec -i '$box' agent-run /usr/local/bin/pi-mcp 2> /dev/null | grep -qF '\"run\":null'"
is "the reasoner's token file is pimcp's alone" pimcp:600 "$(root stat -c '%U:%a' /data/pimcp/tokens/reasoner)"
is 'pi-token refuses a name that is not agent, root or reasoner' 2 "$(root sh -c 'echo pit_x | pi-token pi > /dev/null 2>&1; echo $?')"

echo "# the owner's page"
# Its supervisor runs as pi with piweb its group, so the server makes the page's socket in piweb;
# with the schema and the journal made above, `pi web serve` starts and listens.
web_supervised() { root sh -c "for p in /proc/[0-9]*; do case \$(tr '\0' ' ' < \$p/cmdline 2> /dev/null) in *'/usr/local/lib/pi/supervise web '*) [ \"\$(stat -c %U:%G \$p)\" = pi:piweb ] && exit 0 ;; esac; done; exit 1"; }
must 'the page supervisor runs, as pi with the group piweb' web_supervised
# The page appends to the erasure journal as pi, so it hands the agent API's copy the mark after a write.
web_hands_mark() { root sh -c "for p in /proc/[0-9]*; do case \$(tr '\0' ' ' < \$p/cmdline 2> /dev/null) in *' web serve --agent-journal '*) exit 0 ;; esac; done; exit 1"; }
must "the page's server runs with --agent-journal" wait_for 90 web_hands_mark
must "the page's server makes its socket" wait_for 90 root test -S /data/pi/keys.json.web
is "the page's socket is pi:piweb 660" 'pi:piweb 660' "$(root stat -c '%U:%G %a' /data/pi/keys.json.web)"
is "its control socket is pi's alone, 600" 'pi 600' "$(root stat -c '%U %a' /data/pi/keys.json.web-control)"
is 'the page log is pi-only' pi:600 "$(root stat -c '%U:%a' /data/pi/web.log)"
# Opens SOCKET: an HTTP answer of any status exits 0; a refused connection exits 1.
page_opens='require("node:http").get({ socketPath: process.argv[1], path: "/", headers: { host: "localhost" } }, (r) => { r.resume(); process.exit(0); }).on("error", () => process.exit(1))'
must "pitail opens the page's socket, as tailscale serve does (the positive control)" as_pitail /usr/local/bin/node -e "$page_opens" /data/pi/keys.json.web
must 'and pi' as_pi /usr/local/bin/node -e "$page_opens" /data/pi/keys.json.web
for who in agent as_pihttp as_reasoner as_pisend as_pinotify; do
  mustnot "$who cannot open the page's socket" "$who" /usr/local/bin/node -e "$page_opens" /data/pi/keys.json.web
done
mustnot 'pitail cannot open the control socket' as_pitail /usr/local/bin/node -e "$page_opens" /data/pi/keys.json.web-control
mustnot 'nor read the key file' as_pitail cat /data/pi/keys.json
mustnot 'nor the journal' as_pitail cat /data/pi/keys.json.erasures
mustnot 'nor admin.env' as_pitail cat /run/pi/admin.env
# A daemon that ends is started again, as pitail.
root sh -c "kill $tpid"
restarted() { local p; p=$(tailscaled_pid) && [ "$p" != "$tpid" ]; }
must 'a tailscaled that ends is started again' wait_for 90 restarted
is 'as pitail' pitail "$(root stat -c %U "/proc/$(tailscaled_pid)")"
# Its supervisor's end line, in pitail's own log, and its fast-exit count.
must 'and its supervisor logs its end' root grep -q '"event":"tailscaled_end"' /data/pitail/tailscaled.log
must 'and keeps its count of fast exits where the timer reads it' root test -f /run/pistate/tailscaled.restarts
mustnot 'still no Tailscale process runs as root' tailscale_as root
must 'and the container log holds nothing but fixed lines' only_fixed_lines

echo '# what agent cannot read'
for path in /data/pi/keys.json /data/pi/keys.json.erasures /run/pi/admin.env /run/pi/sync.env /run/pimcp/mcp.env /run/pi/extract.env /run/pi/work.env /run/pi/model-key.env /run/reasoner/reasoner.env /run/pisend/send.env /data/pimcp/tokens/agent /data/pimcp/tokens/root /data/pimcp/tokens/reasoner; do
  must "root reads $path (the positive control)" root cat "$path"
  mustnot "agent cannot read $path" agent cat "$path"
done
mustnot 'agent cannot list /data/pi' agent ls /data/pi
mustnot 'agent cannot list /run/pi' agent ls /run/pi
mustnot 'agent cannot list /run/reasoner' agent ls /run/reasoner
mustnot 'agent cannot list /run/pisend' agent ls /run/pisend
mustnot 'agent cannot list /run/pimcp' agent ls /run/pimcp
mustnot 'agent cannot list /data/pimcp' agent ls /data/pimcp
mustnot "agent cannot read the agent API's key file" agent cat /data/pimcp/keys.json
is 'agent is in no group but its own' agent "$(agent id -Gn)"
# A root process that holds the secrets in its environment, as an owner's session might.
# Found by its command line: tail-config, root's too, has a sleep of its own, with an empty
# environment, until the node joins.
docker exec -d "$box" sleep 300
root_sleep() { root sh -c 'for p in /proc/[0-9]*; do [ "$(tr "\0" " " < "$p/cmdline" 2> /dev/null)" = "sleep 300 " ] && [ "$(stat -c %U "$p")" = root ] && echo "${p#/proc/}"; done' | head -n 1; }
root_sleep_up() { [ -n "$(root_sleep)" ]; }
wait_for 10 root_sleep_up
rootpid=$(root_sleep)
must 'a root process holds the canary in its environment (the positive control)' root grep -qaF "$canary" "/proc/$rootpid/environ"
must 'and the proxy URL and the send secret (the positive control, R14)' root sh -c "grep -qaF '$proxypw' /proc/$rootpid/environ && grep -qaF '$sendsecret' /proc/$rootpid/environ"
mustnot "agent cannot read a root process's environment" agent cat "/proc/$rootpid/environ"
mustnot "agent cannot read a pi process's environment" agent cat /proc/1/environ
is 'a session for agent holds no PI_ variable' 0 "$(agent env | grep -c '^PI_')"
is 'nor the canary' 0 "$(agent env | grep -cF "$canary")"
is 'nor the proxy password or the send secret' 0 "$(agent env | grep -cF -e "$proxypw" -e "$sendsecret")"
# No process of agent holds the pipeline URL, nor any PI_ variable: each one agent can read is
# read, while a session of agent's is open and the agent API runs for it.
docker exec -d "$box" agent-run sleep 30
( sleep 20 | docker exec -i "$box" agent-run /usr/local/bin/pi-mcp > /dev/null 2>&1 ) &
sleep 3
agent_envs=$(printf '%s\n' "$PI_DATABASE_URL_PIPELINE" | agent sh -c 'IFS= read -r url; n=0; hits=0; for p in /proc/[0-9]*; do [ "$(stat -c %U "$p" 2> /dev/null)" = agent ] || continue; e=$(tr "\0" "\n" < "$p/environ" 2> /dev/null) || continue; n=$((n + 1)); if printf "%s\n" "$e" | grep -q "^PI_" || printf "%s\n" "$e" | grep -qF "$url"; then hits=$((hits + 1)); fi; done; echo "$n $hits"')
[ "${agent_envs%% *}" -ge 2 ] && ok "agent's own processes are read (the positive control)" || no "agent's own processes are read (the positive control, got '$agent_envs')"
is 'no process of agent holds the pipeline URL' 0 "${agent_envs##* }"
for role in postgres pi_admin pi_writer pi_reader pi_pipeline pi_work pi_bootstrap; do
  mustnot "agent cannot log in to Postgres as $role" agent psql -w -Atc 'select 1' "postgres://$role@$pg:5432/pi"
done

echo '# what the reasoner cannot read'
is 'the reasoner user has fixed ids, no home and no shell' 'reasoner 901 901 /nonexistent /usr/sbin/nologin' "$(root getent passwd reasoner | awk -F: '{print $1, $3, $4, $6, $7}')"
is 'it is in no group but its own' reasoner "$(as_reasoner id -Gn)"
is 'and owns nothing on the volume' '' "$(root find /data -user reasoner -print | head -n 1)"
for path in /data/pi/keys.json /data/pi/keys.json.erasures /run/pi/admin.env /run/pi/sync.env /run/pimcp/mcp.env /run/pi/extract.env /run/pi/work.env /run/pi/model-key.env /run/pisend/send.env /data/pimcp/tokens/agent /data/pimcp/tokens/root /data/pimcp/tokens/reasoner; do
  must "root reads $path (the positive control)" root cat "$path"
  mustnot "the reasoner cannot read $path" as_reasoner cat "$path"
done
mustnot 'the reasoner cannot list /data/pi' as_reasoner ls /data/pi
mustnot 'the reasoner cannot list /run/pi' as_reasoner ls /run/pi
mustnot 'the reasoner cannot list /run/pisend' as_reasoner ls /run/pisend
mustnot 'the reasoner cannot list /run/pimcp' as_reasoner ls /run/pimcp
mustnot 'the reasoner cannot list /data/pimcp' as_reasoner ls /data/pimcp
mustnot "the reasoner cannot read a pi process's environment" as_reasoner cat /proc/1/environ
for role in postgres pi_admin pi_writer pi_reader pi_pipeline pi_work pi_bootstrap; do
  mustnot "the reasoner cannot log in to Postgres as $role" as_reasoner psql -w -Atc 'select 1' "postgres://$role@$pg:5432/pi"
done
# The reasoner's own code: the entry loads, and the database driver is not linked for its
# package. That is all this shows: the driver is on disk, world-readable, and loads by its
# absolute path. What matters is the checks above: the user holds no URL, password or token.
clean_env='env -i PATH=/usr/local/bin:/usr/bin:/bin'
reasoner_main=/opt/intelligence/apps/reasoner/src/main.ts
case $(as_reasoner $clean_env node "$reasoner_main" 2>&1) in
  *'"code":"usage"'*) ok "node, as the reasoner, loads the reasoner's entry" ;;
  *) no "node, as the reasoner, loads the reasoner's entry" ;;
esac
must 'from the store folder the driver loads (the positive control)' as_reasoner sh -c 'cd /opt/intelligence/packages/store && node -e "require(\"pg\")"'
mustnot "from the reasoner's folder it does not" as_reasoner sh -c 'cd /opt/intelligence/apps/reasoner && node -e "require(\"pg\")"'
is 'with a database URL in its environment the reasoner exits 1 with wrong_role_url' '1 {"event":"reasoner_failed","code":"wrong_role_url"}' "$(out=$(as_reasoner $clean_env PI_REASONER_MODEL=x PI_REASONER_MODEL_KEY=y "PI_DATABASE_URL_READER=$PI_DATABASE_URL_READER" node "$reasoner_main" once 2>&1); echo "$? $out")"

echo '# what agent cannot change or run'
is 'nothing pi or agent runs is writable by anyone but root' '' "$(root sh -c 'find /opt/intelligence /usr/local/bin /usr/local/lib /etc/sudoers /etc/sudoers.d "$(readlink -f /usr/local/bin/node)" ! -type l \( ! -user root -o -perm /022 \) -print' | head -n 5)"
mustnot 'agent cannot write the code' agent test -w /opt/intelligence/apps/pi/src/main.ts
must 'the google package is in the image (a positive control for the next check)' root test -d /opt/intelligence/packages/google/src
mustnot 'and its scripts folder, which the owner runs on their own computer, is not' root test -e /opt/intelligence/packages/google/scripts
# The owner's page: built in its own stage, copied root-owned and read-only.
web_dist=/opt/intelligence/apps/web/dist
must "the page's bundle is in the image, with its manifest and page" root test -f "$web_dist/manifest.json" -a -f "$web_dist/index.html"
is "the page's bundle is root-owned, files 0444 and folders 0555" '' "$(root find "$web_dist" \( ! -user root -o ! -group root -o \( -type f ! -perm 444 \) -o \( -type d ! -perm 555 \) \) -print | head -n 5)"
mustnot "the image holds no node_modules of the page's client" root test -e /opt/intelligence/apps/web/node_modules
mustnot 'agent cannot write the wrapper' agent test -w /usr/local/bin/pi-mcp
is 'pi-admin refuses agent' 'only root and pi run this' "$(agent pi-admin status 2>&1)"
is 'pi-sync refuses agent' 'only root and pi run this' "$(agent pi-sync sync 2>&1)"
is 'pi-extract refuses agent' 'only root and pi run this' "$(agent pi-extract extract 2>&1)"
is 'pi-reasoner refuses agent' 'only root and pi run this' "$(agent pi-reasoner 2>&1)"
mustnot 'agent cannot run pi-migrate' agent /usr/local/bin/pi-migrate
mustnot 'agent cannot run pi-db-init' agent /usr/local/bin/pi-db-init
mustnot 'agent cannot run pi-token' agent /usr/local/bin/pi-token agent
mustnot 'agent cannot run agent-run' agent /usr/local/bin/agent-run true
is 'pi run by agent itself has no secret to start with' '{"event":"command_failed","code":"missing_env"}' "$(agent pi status 2>&1 | head -n 1)"

echo '# sudo, for agent'
is 'sudo lists one rule: pi-mcp as pimcp, with no argument' '    (pimcp) NOPASSWD: /usr/local/bin/pi-mcp ""' "$(agent sudo -n -l 2> /dev/null | sed -n '/may run the following/,$p' | tail -n +2)"
must 'sudo refuses any other command' sudo_refuses true
must 'sudo refuses a shell as pi' sudo_refuses -u pi /bin/sh
must 'sudo refuses a shell as pimcp' sudo_refuses -u pimcp /bin/sh
must 'sudo refuses pi-mcp as pi' sudo_refuses -u pi /usr/local/bin/pi-mcp
must 'sudo refuses the agent API loader as pimcp' sudo_refuses -u pimcp /usr/local/lib/pi/mcp-run mcp mcp
must 'sudo refuses pi-admin as pi' sudo_refuses -u pi /usr/local/bin/pi-admin status
must 'sudo refuses pi-sync as pi' sudo_refuses -u pi /usr/local/bin/pi-sync sync
must 'sudo refuses pi-extract' sudo_refuses /usr/local/bin/pi-extract extract
must 'sudo refuses pi-extract as pi' sudo_refuses -u pi /usr/local/bin/pi-extract extract
must 'sudo refuses pi-work as pi' sudo_refuses -u pi /usr/local/bin/pi-work work tick
must 'sudo refuses pi-reasoner as the reasoner' sudo_refuses -u reasoner /usr/local/bin/pi-reasoner
must 'sudo refuses pi-reasoner as pi' sudo_refuses -u pi /usr/local/bin/pi-reasoner
must 'sudo refuses the launcher as pi' sudo_refuses -u pi /usr/local/bin/pi status
must 'sudo refuses the loader as pi' sudo_refuses -u pi /usr/local/lib/pi/run mcp mcp
must 'sudo refuses pi-mcp with an argument' sudo_refuses -u pimcp /usr/local/bin/pi-mcp mcp
must 'sudo refuses pi-mcp as root' sudo_refuses -u root /usr/local/bin/pi-mcp
is 'sudo runs pi-mcp as pimcp (the positive control)' "$pong" "$(printf '%s\n' "$ping" | agent sudo -n -u pimcp /usr/local/bin/pi-mcp 2> /dev/null)"
# What agent sets in its own environment reaches neither sudo's command nor pimcp.
other='PI_DATABASE_URL_ADMIN=postgres://a:b@c/d'
is 'pi mcp refuses a second role URL in its environment (the positive control)' '{"event":"command_failed","code":"wrong_role_url"}' "$(agent env "$other" PI_DATABASE_URL_READER=postgres://a:b@c/d PI_KEY_FILE=/x pi mcp 2>&1 < /dev/null)"
is 'a role URL agent sets does not reach pimcp' "$pong" "$(printf '%s\n' "$ping" | agent env "$other" /usr/local/bin/pi-mcp 2> /dev/null)"
is "agent cannot name itself root to get the bridge's client" 4 "$(printf '%s\n' "$list" | agent env SUDO_USER=root PI_BOX_CALLER=root /usr/local/bin/pi-mcp 2> /dev/null | tools)"

echo '# sudo, for the reasoner and for pi'
sudo_rules() { sed -n '/may run the following/,$p' | tail -n +2; }
refused_by_sudo() { "$@" 2>&1 | grep -qE 'a password is required|not allowed'; }
is 'sudo lists one rule for the reasoner: pi-mcp as pimcp, with no argument' '    (pimcp) NOPASSWD: /usr/local/bin/pi-mcp ""' "$(as_reasoner sudo -n -l 2> /dev/null | sudo_rules)"
is "sudo lists four rules for pi: pi-reasoner as the reasoner and pi-tester as the tester, with no argument, and the journal mark's writer as pimcp and as pihttp" '    (reasoner) NOPASSWD: /usr/local/bin/pi-reasoner ""
    (tester) NOPASSWD: /usr/local/bin/pi-tester ""
    (pimcp) NOPASSWD: /usr/local/lib/pi/agent-file journal
    (pihttp) NOPASSWD: /usr/local/lib/pi/agent-file journal' "$(as_pi sudo -n -l 2> /dev/null | sudo_rules)"
must 'sudo refuses pi the key copy as pihttp' refused_by_sudo as_pi sudo -n -u pihttp /usr/local/lib/pi/agent-file keys
must 'sudo refuses pi a shell as pihttp' refused_by_sudo as_pi sudo -n -u pihttp /bin/sh
is 'with PI_OUTCOME_TEST unset no file holds the key, and the timer has no switch' 'absent absent' "$(root sh -c '[ -e /run/tester/tester.env ] && echo present || echo absent; [ -e /run/pi/tester-on.env ] && echo present || echo absent' | tr '\n' ' ' | sed 's/ $//')"
must 'sudo refuses pi the key copy as pimcp' refused_by_sudo as_pi sudo -n -u pimcp /usr/local/lib/pi/agent-file keys
must 'sudo refuses pi the mark writer with no argument' refused_by_sudo as_pi sudo -n -u pimcp /usr/local/lib/pi/agent-file
must 'sudo refuses pi a shell as pimcp' refused_by_sudo as_pi sudo -n -u pimcp /bin/sh
must 'sudo refuses pi the agent API as pimcp' refused_by_sudo as_pi sudo -n -u pimcp /usr/local/bin/pi-mcp
# The timer's way: the mark as pi, written as pimcp. Anything but one mark line is refused and the
# copy kept.
mark_before=$(as_pimcp cat /data/pimcp/keys.json.erasures)
mustnot 'the mark writer refuses a line that is not a mark' as_pi sh -c 'printf "%s\n" "{\"seq\":1,\"lift\":\"x\"}" | sudo -n -u pimcp /usr/local/lib/pi/agent-file journal'
mustnot 'and two marks' as_pi sh -c 'printf "%s\n%s\n" "{\"mark\":0}" "{\"mark\":0}" | sudo -n -u pimcp /usr/local/lib/pi/agent-file journal'
mustnot 'and nothing' as_pi sh -c 'sudo -n -u pimcp /usr/local/lib/pi/agent-file journal < /dev/null'
mustnot 'and a mark with bytes after it and no newline' as_pi sh -c 'printf "%s\n%s" "{\"mark\":999999999}" "x" | sudo -n -u pimcp /usr/local/lib/pi/agent-file journal'
is 'and keeps the copy as it was' "$mark_before" "$(as_pimcp cat /data/pimcp/keys.json.erasures)"
# The writers take no common lock, so a mark lower than the copy's is refused: the copy set higher
# by pimcp itself, then put back.
as_pimcp sh -c 'printf "%s\n" "{\"mark\":999}" > /data/pimcp/keys.json.erasures'
mustnot 'the mark writer refuses a mark lower than the copy' as_pi sh -c 'printf "%s\n" "{\"mark\":0}" | sudo -n -u pimcp /usr/local/lib/pi/agent-file journal'
is 'and keeps the higher copy' '{"mark":999}' "$(as_pimcp cat /data/pimcp/keys.json.erasures)"
must 'and takes one at least as high' as_pi sh -c 'printf "%s\n" "{\"mark\":999}" | sudo -n -u pimcp /usr/local/lib/pi/agent-file journal'
as_pimcp sh -c 'printf "%s\n" "$1" > /data/pimcp/keys.json.erasures' _ "$mark_before"
must "the timer's way writes pi's mark as pimcp" as_pi sh -c '/usr/local/lib/pi/as-pi admin keys agent-journal | sudo -n -u pimcp /usr/local/lib/pi/agent-file journal'
is 'and the copy is the mark, pimcp:pimcp 600' "pimcp:pimcp 600 $mark_before" "$(root stat -c '%U:%G %a' /data/pimcp/keys.json.erasures) $(as_pimcp cat /data/pimcp/keys.json.erasures)"
# A copy above pi's journal (a lost journal, then an older database restored) would refuse every
# hand as lower for good: root's lib/agent-keys, after any pia command, removes it and hands pi's
# mark again. pi's own way still cannot lower it.
as_pimcp sh -c 'printf "%s\n" "{\"mark\":999999}" > /data/pimcp/keys.json.erasures'
mustnot "pi's way cannot lower a copy above the journal" as_pi sh -c '/usr/local/lib/pi/as-pi admin keys agent-journal | sudo -n -u pimcp /usr/local/lib/pi/agent-file journal'
root pi-admin status > /dev/null 2>&1
is "root's agent-keys puts pi's mark back over a copy above the journal" "$mark_before" "$(as_pimcp cat /data/pimcp/keys.json.erasures)"
must 'sudo refuses the reasoner a shell as pi' refused_by_sudo as_reasoner sudo -n -u pi /bin/sh
must 'sudo refuses the reasoner pi-mcp with an argument' refused_by_sudo as_reasoner sudo -n -u pimcp /usr/local/bin/pi-mcp mcp
must 'sudo refuses the reasoner pi-mcp as pi' refused_by_sudo as_reasoner sudo -n -u pi /usr/local/bin/pi-mcp
must 'sudo refuses the reasoner pi-mcp as root' refused_by_sudo as_reasoner sudo -n -u root /usr/local/bin/pi-mcp
must 'sudo refuses the reasoner pi-admin as pi' refused_by_sudo as_reasoner sudo -n -u pi /usr/local/bin/pi-admin status
must 'sudo refuses pi a shell as the reasoner' refused_by_sudo as_pi sudo -n -u reasoner /bin/sh
must 'sudo refuses pi the reasoner with an argument' refused_by_sudo as_pi sudo -n -u reasoner /usr/local/bin/pi-reasoner once
must 'sudo refuses pi any command as root' refused_by_sudo as_pi sudo -n -u root /usr/local/bin/pi-reasoner
must 'sudo refuses pi the agent API as the reasoner' refused_by_sudo as_pi sudo -n -u reasoner /usr/local/bin/pi-mcp
is 'pi-mcp refuses an argument from the reasoner' 2 "$(printf '%s\n' "$ping" | as_reasoner /usr/local/bin/pi-mcp extra > /dev/null 2>&1; echo $?)"
is 'pi-reasoner refuses an argument from root' 2 "$(root pi-reasoner once > /dev/null 2>&1; echo $?)"
is 'and from pi' 2 "$(as_pi /usr/local/bin/pi-reasoner once > /dev/null 2>&1; echo $?)"

echo '# the security review findings'
# agent starts pi-mcp through sudo, whose real uid is agent, so agent can signal that
# sudo process and sudo relays the signal to its node child, which runs as pimcp. node is started
# with --disable-sigusr1, so a relayed SIGUSR1 cannot open the inspector on the pimcp process. No
# other signal changes node's behaviour: SIGQUIT only ends it.
is 'the pi launcher starts node with --disable-sigusr1' yes "$(root sh -c 'grep -q "node --disable-sigusr1" /usr/local/bin/pi && echo yes')"
sigusr1_probe() {
  docker exec -i "$box" agent-run sh -c '
    sleep 8 | sudo -n -u pimcp /usr/local/bin/pi-mcp >/dev/null 2>&1 &
    sleep 2
    for p in /proc/[0-9]*; do c=$(tr "\0" " " < "$p/cmdline" 2>/dev/null); case $c in "sudo -n -u pimcp"*) kill -USR1 "${p#/proc/}" 2>/dev/null ;; esac; done
    sleep 1
    node -e "require(\"net\").connect(9229,\"127.0.0.1\").on(\"connect\",()=>{console.log(\"open\");process.exit()}).on(\"error\",()=>{console.log(\"closed\");process.exit()})"
  ' 2>/dev/null
}
is 'a SIGUSR1 relayed through sudo does not open the pimcp process inspector' closed "$(sigusr1_probe)"

# However pi-migrate ends, the bootstrap role is never left able to log in. A blocked
# migration has enabled the role; a signal to its process group, as a dropped session sends, must
# still disable it. A SIGKILL cannot run the handler, so it is left to the next run to repair.
pgq() { docker exec "$pg" psql -U postgres -Atc "$1" postgres; }
canlogin() { pgq "select rolcanlogin from pg_roles where rolname = 'pi_bootstrap'"; }
# The migration itself has started: `pi db migrate`, the process pi-migrate hands over to.
migrating() { root sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline" 2> /dev/null; echo; done' | grep -q 'main.ts db migrate'; }
migrate_then_signal() {
  local sig=$1
  docker exec "$pg" psql -U postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where query like '%advisory%' and pid <> pg_backend_pid()" postgres > /dev/null 2>&1
  docker exec -d "$pg" psql -U postgres -c "select pg_advisory_lock(hashtext('intelligence personal roles')); select pg_sleep(30)" postgres > /dev/null 2>&1
  sleep 1
  ( printf 'postgres\n%s\n' "$super"; sleep 20 ) | docker exec -i "$box" pi-migrate > /dev/null 2>&1 &
  wait_for 20 root test -e /run/pi/bootstrap.env
  wait_for 10 migrating
  # While the migration waits: what the processes that run as pi hold in their environments,
  # read as pi, since no other user reads them.
  pi_migrating=$(as_pi sh -c 'for p in /proc/[0-9]*; do [ "$(stat -c %U "$p" 2> /dev/null)" = pi ] && tr "\0" " " < "$p/cmdline" 2> /dev/null && echo; done' | grep -c 'db migrate')
  pi_env=$(as_pi sh -c 'for p in /proc/[0-9]*; do [ "$(stat -c %U "$p" 2> /dev/null)" = pi ] && tr "\0" "\n" < "$p/environ" 2> /dev/null; done')
  pi_reads=$(printf '%s\n' "$pi_env" | grep -c '^PI_DATABASE_URL_BOOTSTRAP=')
  pi_holds=$(printf '%s\n' "$pi_env" | grep -cF "$super")
  boot_has=$(root grep -c '^PI_DATABASE_URL_BOOTSTRAP=' /run/pi/bootstrap.env)
  boot_proxy=$(root grep -c -e PROXY -e "$proxypw" /run/pi/bootstrap.env)
  root sh -c 'for p in /proc/[0-9]*; do c=$(tr "\0" " " < "$p/cmdline" 2>/dev/null); case $c in "/bin/sh /usr/local/bin/pi-migrate "*) pid=${p#/proc/}; kill -'"$sig"' -"$(awk "{print \$5}" "/proc/$pid/stat")" 2>/dev/null; break ;; esac; done'
  docker exec "$pg" psql -U postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where query like '%pg_sleep(30)%' and pid <> pg_backend_pid()" postgres > /dev/null 2>&1
  sleep 2
}
for sig in HUP INT TERM; do
  migrate_then_signal "$sig"
  if [ "$sig" = HUP ]; then
    # The emptied environment, by what runs: the migration is a pi process whose environment was
    # read (it holds the bootstrap URL), and no pi process holds the superuser's password. This
    # catches an environment that is not emptied at all; the order of the two steps is checked
    # below.
    [ "$pi_migrating" -ge 1 ] && ok 'during pi-migrate the migration runs as pi (the positive control)' || no 'during pi-migrate the migration runs as pi (the positive control)'
    [ "$pi_reads" -ge 1 ] && ok "its environment was read: it holds the bootstrap URL (the positive control)" || no "its environment was read: it holds the bootstrap URL (the positive control)"
    is "no process that runs as pi holds the superuser's password" 0 "$pi_holds"
    [ "$boot_has" -ge 1 ] && ok 'during pi-migrate bootstrap.env holds the bootstrap URL (the positive control)' || no 'during pi-migrate bootstrap.env holds the bootstrap URL (the positive control)'
    is 'and never the proxy URL (C7)' 0 "$boot_proxy"
  fi
  is "pi-migrate stopped by SIG$sig leaves the bootstrap role unable to log in" f "$(canlogin)"
  mustnot "and no bootstrap.env remains after SIG$sig" root test -e /run/pi/bootstrap.env
done
migrate_then_signal KILL
is 'SIGKILL leaves the role able to log in (the hazard the next run must repair)' t "$(canlogin)"
# What bounds that hazard when no next run comes: the password expires, and the server refuses it.
is 'but its password expires within thirty minutes' t "$(pgq "select rolvaliduntil > now() and rolvaliduntil <= now() + interval '31 minutes' from pg_roles where rolname = 'pi_bootstrap'")"
leftover=$(root sed -n 's/^PI_DATABASE_URL_BOOTSTRAP=//p' /run/pi/bootstrap.env)
must 'until then the leftover password logs in (the positive control)' root psql -w -Atc 'select 1' "$leftover"
pgq "alter role pi_bootstrap valid until '2000-01-01'" > /dev/null
mustnot 'once the expiry has passed the server refuses it' root psql -w -Atc 'select 1' "$leftover"
printf 'postgres\n%s\n' "$super" | root pi-migrate > /dev/null 2>&1
is 'the next pi-migrate run repairs the SIGKILL leak before doing its own work' f "$(canlogin)"
mustnot 'and leaves no bootstrap.env' root test -e /run/pi/bootstrap.env

# The environment is emptied (env -i, through $clean) before privileges drop
# (setpriv), so no process that runs as pi ever holds what the caller passed, the Postgres
# superuser password pi-migrate passes to the migration among it. The checks above read the
# running processes; these two read the order in the wrappers, which a race could hide.
for f in /usr/local/lib/pi/as-pi /usr/local/bin/pi-mcp; do
  is "$f empties the environment before it drops its user" yes "$(root sh -c "grep -Eq 'exec [\$]clean /usr/bin/setpriv' '$f' && echo yes")"
done

# No root process writes, reads or executes a path a less-privileged user can replace.
# /run/pi is root's with group pi, so pi reads the role files but cannot plant a symlink the
# entrypoint or pi-migrate would follow; pi-token writes its file as pimcp, not as root, inside
# pimcp-owned /data/pimcp/tokens.
is '/run/pi is root-owned, group pi, and not writable by pi' 'root:pi 750' "$(root stat -c '%U:%G %a' /run/pi)"
mustnot 'pi cannot create a file in /run/pi' as_pi sh -c 'touch /run/pi/planted'
must 'pi can still read a role file in /run/pi' as_pi test -r /run/pi/admin.env
# So the timer, which runs as pi, cannot remove the model key's file after its import succeeds,
# and empties it instead.
mustnot 'pi cannot remove the model key file' as_pi rm -f /run/pi/model-key.env
must 'but can empty it, as the timer does after a successful import' as_pi sh -c ': > /run/pi/model-key.env'
mustnot 'which leaves no key in it' root test -s /run/pi/model-key.env
is 'the timer empties the file after a successful import' yes "$(root sh -c "grep -q ': > /run/pi/model-key.env' /usr/local/lib/pi/sync-timer && echo yes")"
is 'pi-token writes its file as the pimcp user, not as root' yes "$(root sh -c 'grep -q "setpriv --reuid=pimcp" /usr/local/bin/pi-token && echo yes')"
# The entrypoint makes the tokens directory, which is inside pimcp's own. A symlink pimcp puts in
# its place must not have root hand its target to pimcp at the next start.
as_pimcp sh -c 'mv /data/pimcp/tokens /data/pimcp/tokens.kept && ln -s /etc/sudoers.d /data/pimcp/tokens'
docker restart "$box" > /dev/null
wait_for 30 root test -f /run/pimcp/mcp.env
# With the schema in place, the start's import succeeds and removes the file.
imported() { start_code "$box" model_key_imported; }
must 'after a restart with a schema, the start imports the model key' wait_for 60 imported
mustnot 'and no copy of it is left in /run/pi' root grep -qrF "$modelkey" /run/pi
is 'a symlink pimcp plants as its tokens directory gives pimcp nothing at the next start' 'root:root 755' "$(root stat -c '%U:%G %a' /etc/sudoers.d)"
mustnot 'pimcp cannot write where the symlink pointed' as_pimcp touch /etc/sudoers.d/planted
as_pimcp sh -c 'rm /data/pimcp/tokens && mv /data/pimcp/tokens.kept /data/pimcp/tokens'
# Nothing reads the old paths in /data/pi, which pi owns; the extraction section shows that a file
# pi makes there switches nothing on.
is '/data is root-owned and not writable by pi' 'root:root 755' "$(root stat -c '%U:%G %a' /data)"
mustnot 'pi cannot create a file in /data' as_pi touch /data/sync-hold
mustnot 'nor agent' agent touch /data/sync-hold
must 'pi can create one in /data/pi (the positive control)' as_pi sh -c 'touch /data/pi/planted && rm /data/pi/planted'

# pi can write admin.env, so the superuser scripts must not take the server from it: a
# compromised pi would name a server of its own there and be sent the password the owner types.
# A listener run as pi on a port of its own stands in for that server; it notes the user each
# connection names. pi's own commands read admin.env too, and the timer's runs connect as pi_admin
# whenever one falls in this window: pi holds that URL already, so only another user is a leak.
decoy_server='const fs = require("node:fs");
fs.writeFileSync("/data/pi/decoy.pid", String(process.pid));
require("node:net").createServer((socket) => {
  socket.on("error", () => {});
  socket.on("data", (bytes) => {
    const code = bytes.length >= 8 ? bytes.readUInt32BE(4) : 0;
    if (code === 80877103 || code === 80877104) return void socket.write("N");
    const words = bytes.subarray(8).toString().split("\0");
    fs.appendFileSync(process.argv[1], `${words[words.indexOf("user") + 1]}\n`);
    socket.destroy();
  });
}).listen(5499, "127.0.0.1");
setTimeout(() => process.exit(), 120000);'
is 'the superuser host is in a directory only root reads or writes' 'root:root 700 root:root 600' "$(root stat -c '%U:%G %a' /run/pi-root /run/pi-root/admin-host | tr '\n' ' ' | sed 's/ $//')"
is 'and it holds the host and port of the admin URL' "$pg:5432" "$(root cat /run/pi-root/admin-host)"
decoy=127.0.0.1:5499
decoy_log=/data/pi/decoy.log
docker exec -d "$box" setpriv --reuid=pi --regid=pi --init-groups node -e "$decoy_server" "$decoy_log"
decoy_hits() { root sh -c "cat $decoy_log 2> /dev/null | grep -vcx pi_admin" | tr -d ' '; }
decoy_up() { as_pi psql -w -Atc 'select 1' "postgres://probe@$decoy/postgres"; [ "$(decoy_hits)" -ge 1 ]; }
must 'a connection to the decoy server is noted (the positive control)' wait_for 20 decoy_up
as_pi sh -c "rm -f $decoy_log; cp /run/pi/admin.env /data/pi/admin.env.kept; new=\$(sed 's|@[^/]*/|@$decoy/|' /run/pi/admin.env) && printf '%s\n' \"\$new\" > /run/pi/admin.env"
must 'pi has pointed admin.env at the decoy (the positive control)' root grep -qF "@$decoy/" /run/pi/admin.env
must 'pi-db-init still runs against the real server' sh -c "printf 'postgres\n%s\n' '$super' | docker exec -i '$box' pi-db-init"
is 'and no user but pi_admin reached the server pi named' 0 "$(decoy_hits)"
is 'pi-migrate still succeeds against the real server' 'bootstrap can log in: false 0' "$(migrate_result)"
is 'and no user but pi_admin reached the server pi named' 0 "$(decoy_hits)"
as_pi sh -c "cat /data/pi/admin.env.kept > /run/pi/admin.env; rm -f /data/pi/admin.env.kept $decoy_log"
root sh -c 'kill "$(cat /data/pi/decoy.pid)"; rm -f /data/pi/decoy.pid'

echo '# the read hold'
# A session opened before the hold: a client keeps its endpoint open.
api_running() { root sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline" 2> /dev/null; echo; done' | grep -q '/apps/pi/src/main.ts mcp $'; }
( sleep 40 | docker exec -i "$box" agent-run /usr/local/bin/pi-mcp > /dev/null 2>&1 ) &
must 'a session is open before the hold (the positive control)' wait_for 20 api_running
root pi-read-hold on
mustnot 'pi-read-hold on ends the session that was already open' api_running
must 'and sets the hold' root test -e /data/read-hold
mustnot 'agent cannot run pi-read-hold' agent /usr/local/bin/pi-read-hold off
is 'while the read hold exists, pi-mcp answers agent nothing' '' "$(printf '%s\n' "$ping" | agent /usr/local/bin/pi-mcp 2> /dev/null)"
is 'nor the bridge' '' "$(printf '%s\n' "$ping" | root /usr/local/bin/pi-mcp 2> /dev/null)"
is 'nor agent through sudo' '' "$(printf '%s\n' "$ping" | agent sudo -n -u pimcp /usr/local/bin/pi-mcp 2> /dev/null)"
mustnot 'agent cannot clear the read hold' agent rm -f /data/read-hold
mustnot 'pi cannot clear the read hold' as_pi rm -f /data/read-hold
must 'the read hold is still there (the positive control)' root test -e /data/read-hold
root pi-read-hold off
is 'with the hold cleared, pi-mcp answers again' "$pong" "$(printf '%s\n' "$ping" | agent /usr/local/bin/pi-mcp 2> /dev/null)"

echo '# Claude Code, as agent'
must 'claude runs' agent claude --version
must 'the documented registration, with no token in it' agent claude mcp add --scope user personal-intelligence -- /usr/local/bin/pi-mcp
must 'its configuration is on the volume' root grep -q /usr/local/bin/pi-mcp /data/agent/.claude.json
mustnot 'and holds no token' root grep -q pit_ /data/agent/.claude.json
must 'Claude Code itself starts pi-mcp and completes the handshake' sh -c "docker exec -i '$box' agent-run claude mcp list 2>&1 | grep -q 'personal-intelligence.*Connected'"
echo smoke-not-a-key | agent sh -c 'umask 077; IFS= read -r k; printf "ANTHROPIC_API_KEY=%s\nSMOKE_OTHER=set\n" "$k" > ~/claude.env'
is "a sign-in the owner stores reaches agent's session" smoke-not-a-key "$(agent sh -c 'echo $ANTHROPIC_API_KEY')"
is 'and no other line of that file does' unset "$(agent sh -c 'echo ${SMOKE_OTHER:-unset}')"

echo '# the timer, across a restart'
lines() { root sh -c 'grep -c sync_timer_run /data/pi/sync.log'; }
runs_before=$(lines)
started=$(date +%s)
docker restart "$box" > /dev/null
[ $(($(date +%s) - started)) -lt 8 ] && ok 'the box stops at once when asked' || no 'the box stops at once when asked'
# A run that started after this restart, not a line an earlier one left in the log.
timer_ran_again() { [ "$(lines)" -gt "$runs_before" ] && root sh -c 'tail -n 2 /data/pi/sync.log | grep -q "\"event\":\"no_accounts\""'; }
must 'after a restart with keys and a schema, the timer has run a sync that found no account' wait_for 60 timer_ran_again
is 'the sync log is pi-only: sync ran as pi' pi:600 "$(root stat -c '%U:%a' /data/pi/sync.log)"
mustnot 'it holds only event lines' root grep -qv '^{"event"' /data/pi/sync.log
timer_is_pi() { [ "$(root stat -c %U /proc/1 2> /dev/null)" = pi ]; }
must 'the first process is pi again' wait_for 30 timer_is_pi
must 'the key file is still there' root test -f /data/pi/keys.json
case $(printf '%s\n' "$init" | agent /usr/local/bin/pi-mcp 2> /dev/null) in
  *'"protocolVersion":"2025-06-18"'*) ok 'the token and the rewritten secret files still serve agent' ;;
  *) no 'the token and the rewritten secret files still serve agent' ;;
esac
must "Claude Code's registration is still there" agent claude mcp get personal-intelligence
must 'the container log still holds nothing but fixed lines' only_fixed_lines
mustnot 'and no canary' sh -c "docker logs '$box' 2>&1 | grep -qF '$canary'"
mustnot 'the model key is not in the container log' sh -c "docker logs '$box' 2>&1 | grep -qF '$modelkey'"
mustnot 'nor in the sync log' root grep -qF "$modelkey" /data/pi/sync.log
root touch /data/sync-hold
before=$(lines)
docker restart "$box" > /dev/null
sleep 5
is 'while the hold file exists, no sync starts' "$before" "$(lines)"
root rm /data/sync-hold
# The log is moved aside at about 5 MB, before the next run writes.
as_pi sh -c 'head -c 5000001 /dev/zero | tr "\0" x > /data/pi/sync.log'
docker restart "$box" > /dev/null
must 'a sync log at the size bound is moved aside' wait_for 60 root test -f /data/pi/sync.log.1
[ "$(root sh -c 'wc -c < /data/pi/sync.log' 2> /dev/null || echo 9999999)" -lt 5000000 ] && ok 'and a new one is started' || no 'and a new one is started'

echo '# extraction on the timer'
# Each start runs the loop at once, so a restart is a tick. A tick's extract lines are counted.
xruns() { root sh -c 'cat /data/pi/extract.log 2> /dev/null | grep -c extract_timer_run'; }
# The timer is in its sleep: the first process's child is `sleep 120`, so this tick has decided.
timer_asleep() { root sh -c 'for p in /proc/[0-9]*; do [ "$(awk "{print \$4}" "$p/stat" 2> /dev/null)" = 1 ] && tr "\0" " " < "$p/cmdline" 2> /dev/null && echo; done' | grep -q '^sleep 120 $'; }
# A restart, waited on until this start's tick is over: the container log keeps every earlier
# start's lines, so the count of ready lines must grow, and then the timer must be asleep.
starts() { start_count "$box" ready; }
started_again() { [ "$(starts)" -gt "$1" ]; }
restart_box() { local n; n=$(starts); docker restart "$box" > /dev/null; wait_for 60 started_again "$n"; wait_for 60 timer_asleep; }
mustnot 'after many ticks with no extract-on the timer has started no extract' root test -e /data/pi/extract.log
# The owner's switch, and the real wrapper: no message is stored, so the run has nothing to send
# and makes no model call.
root touch /data/extract-on
restart_box
real_ran() { root grep -qE '^\{"event":"extract_run",.*"code":"ok"\}$' /data/pi/extract.log; }
must 'with extract-on the timer runs pi-extract extract after the sync, and the run ends ok' wait_for 60 real_ran
timer_line='^\{"event":"extract_timer_run","at":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z","level":"info"\}$'
is 'each run starts with one timer line that carries the time' 1 "$(root grep -cE "$timer_line" /data/pi/extract.log)"
is 'the extract log is pi-only: extract ran as pi' pi:600 "$(root stat -c '%U:%a' /data/pi/extract.log)"
mustnot 'it holds only event lines' root grep -qv '^{"event"' /data/pi/extract.log
is 'and the run made no model call' 0 "$(docker exec "$pg" psql -U postgres -Atc 'select count(*) from vault.model_usage' pi)"
mustnot 'extract lines reach neither the sync log' root grep -q extract_run /data/pi/sync.log
mustnot 'nor the container log' sh -c "docker logs '$box' 2>&1 | grep -q extract_run"
# HO5: the run read its key's limit before anything else, from the fake key endpoint on the box's
# loopback. A line is matched by its fields, whatever their order.
spend_ok() { root sh -c "grep '\"event\":\"spend_cap\"' '$1' | grep '\"code\":\"ok\"' | grep -q '\"limit_micro_usd\":5000000'"; }
case $(root sh -c 'grep -v extract_timer_run /data/pi/extract.log | head -n 1') in
  *'"event":"spend_cap"'*) ok "the run's first line is its spend-cap line" ;;
  *) no "the run's first line is its spend-cap line" ;;
esac
must "and it reads ok, with the fake endpoint's limit" spend_ok /data/pi/extract.log
[ "$(key_asked)" -gt 0 ] && ok 'the fake key endpoint was asked, on the box loopback' || no 'the fake key endpoint was asked, on the box loopback'
mustnot 'neither model key reaches the extract log' root grep -qF -e "$modelkey" -e "$reasonerkey" /data/pi/extract.log
# A key endpoint that answers what does not parse: the fake's key path garbled for one run, in its
# own container, then put back. The run is refused before any model call.
docker exec "$keys" touch /tmp/garbled
asked_before=$(key_asked)
garbled=$(root pi-extract extract 2>&1); garbled_status=$?
[ "$(key_asked)" -gt "$asked_before" ] && ok 'the garbled endpoint was asked (the positive control)' || no 'the garbled endpoint was asked (the positive control)'
is 'a key endpoint that answers what does not parse ends the run with exit 1' 1 "$garbled_status"
printf '%s\n' "$garbled" | grep '"event":"spend_cap"' | grep -q '"code":"spend_cap_unknown"' && ok 'its spend-cap line reads spend_cap_unknown' || no "its spend-cap line reads spend_cap_unknown (got '$garbled')"
printf '%s\n' "$garbled" | untimed | grep -qx '{"event":"command_failed","code":"spend_cap_unknown"}' && ok 'and the run is refused spend_cap_unknown' || no "and the run is refused spend_cap_unknown (got '$garbled')"
is 'and no model call was made' 0 "$(docker exec "$pg" psql -U postgres -Atc 'select count(*) from vault.model_usage' pi)"
docker exec "$keys" rm /tmp/garbled
# A stand-in for the wrapper that runs for a while and then fails: the timer must not wait for
# it, and its failure is one fixed line on the box output. Root replaces the root-owned file.
root sh -c 'cp /usr/local/bin/pi-extract /usr/local/bin/pi-extract.kept && printf "%s\n" "#!/bin/sh" "echo \"{\\\"event\\\":\\\"stand_in\\\"}\" >&2" "sleep 20" "exit 3" > /usr/local/bin/pi-extract'
before=$(xruns)
restart_box
stand_in_running() { root sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline" 2> /dev/null; echo; done' | grep -q '^sleep 20 $'; }
must 'the stand-in extract is running (the positive control)' wait_for 30 stand_in_running
must 'the timer returns to its sleep while an extract is still running' timer_asleep
must 'and the extract is still running then' stand_in_running
is 'the stand-in was started once, after its timer line' "$((before + 1))" "$(xruns)"
must 'its lines go to the extract log' root grep -q '"event":"stand_in"' /data/pi/extract.log
failed_line() { box_failed extract_timer_failed exit_3; }
mustnot 'no failure line while it still runs' failed_line
must 'an extract that fails is one fixed line on the box output, with its exit status' wait_for 40 failed_line
must 'and the container log holds nothing but fixed lines' only_fixed_lines
# The hold stops extraction as it stops sync; so does removing the switch; so does a missing
# extract.env, which the start check below covers.
root touch /data/sync-hold
before=$(xruns)
restart_box
is 'while the sync hold exists, no extract starts' "$before" "$(xruns)"
root rm /data/sync-hold
root rm /data/extract-on
restart_box
is 'with extract-on removed, no extract starts' "$before" "$(xruns)"
# The read hold, which stays on after a restore whose first sync failed, stops extraction too:
# nothing reads a restored database before a full sync has run.
root touch /data/extract-on
root pi-read-hold on
restart_box
is 'while the read hold exists, no extract starts' "$before" "$(xruns)"
root pi-read-hold off
root rm /data/extract-on
# The old paths in pi's own directory are no switch: pi turns nothing on and holds nothing there.
as_pi sh -c 'touch /data/pi/extract-on /data/pi/sync-hold'
sbefore=$(lines)
restart_box
is 'an extract-on pi makes at the old path starts no extract' "$before" "$(xruns)"
[ "$(lines)" -gt "$sbefore" ] && ok 'and a sync-hold there holds nothing' || no 'and a sync-hold there holds nothing'
mustnot 'and the start leaves no switch in /data' root sh -c 'test -e /data/extract-on || test -e /data/sync-hold'
as_pi rm -f /data/pi/extract-on /data/pi/sync-hold
# The log is moved aside at about 5 MB, before the next run writes.
root touch /data/extract-on
as_pi sh -c 'head -c 5000001 /dev/zero | tr "\0" x > /data/pi/extract.log'
restart_box
must 'an extract log at the size bound is moved aside' wait_for 60 root test -f /data/pi/extract.log.1
[ "$(root sh -c 'wc -c < /data/pi/extract.log' 2> /dev/null || echo 9999999)" -lt 5000000 ] && ok 'and a new one is started' || no 'and a new one is started'
root rm /data/extract-on
root sh -c 'mv -f /usr/local/bin/pi-extract.kept /usr/local/bin/pi-extract'
is 'the real wrapper is back, root-owned and closed to writes' 'root:755' "$(root stat -c '%U:%a' /usr/local/bin/pi-extract)"

echo '# the tick and the reasoner on the timer'
wruns() { root sh -c 'cat /data/pi/work.log 2> /dev/null | grep -c work_timer_run'; }
rruns() { root sh -c 'cat /data/pi/work.log 2> /dev/null | grep -c reasoner_timer_run'; }
box_lines() { docker logs "$box" 2>&1 | grep -c "$1"; }
before=$(wruns)
rbefore=$(rruns)
failed_before=$(box_lines '"event":"reasoner_failed"')
restart_box
is 'after one loop the timer has started one tick' "$((before + 1))" "$(wruns)"
is 'and one reasoner run after it' "$((rbefore + 1))" "$(rruns)"
must 'work.log holds the tick work_tick line' root sh -c 'tail -n 20 /data/pi/work.log | grep -q "\"event\":\"work_tick\""'
mustnot 'it holds only event lines' root grep -qv '^{"event"' /data/pi/work.log
mustnot 'the container log holds no line of the tick' sh -c "docker logs '$box' 2>&1 | grep -q -e work_tick\\\" -e work_timer_run"
mustnot 'nor of the reasoner run' sh -c "docker logs '$box' 2>&1 | grep -q reasoner_timer_run"
# With no run queued the reasoner takes none and exits 0. This needs the run tools on the agent
# API: without them the reasoner's next_run is refused and it fails.
is 'with no run queued the reasoner exits 0: no new reasoner_failed line' "$failed_before" "$(box_lines '"event":"reasoner_failed"')"
must 'and the container log holds nothing but fixed lines' only_fixed_lines
mustnot 'the reasoner key is in no log' root grep -qF "$reasonerkey" /data/pi/work.log /data/pi/sync.log
# The line after the last reasoner timer line is that run's first: the tick before it has ended.
reasoner_spend_first() { root sh -c 'grep -A1 reasoner_timer_run /data/pi/work.log | tail -n 1' | grep '"event":"spend_cap"' | grep '"code":"ok"' | grep -q '"limit_micro_usd":5000000'; }
must "the reasoner read its key's limit first: its run's first line is spend_cap ok, with the fake endpoint's limit" reasoner_spend_first
mustnot 'nor in the container log' sh -c "docker logs '$box' 2>&1 | grep -qF '$reasonerkey'"

# A run held open, to read what it holds: a stand-in for pi-mcp passes the reasoner's first
# request to the real one only after a while. Root replaces the root-owned file. A line naming
# a database URL is planted in reasoner.env first: the reasoner's loader exports PI_REASONER_
# lines alone, so it must not reach the run.
root sh -c 'cp /run/reasoner/reasoner.env /run/reasoner-kept.env && printf "%s\n" "PI_DATABASE_URL_READER=postgres://planted@x/pi" "OTHER=planted" >> /run/reasoner/reasoner.env'
root sh -c 'cp /usr/local/bin/pi-mcp /usr/local/bin/pi-mcp.kept && printf "%s\n" "#!/bin/sh" "{ sleep 12; cat; } | /usr/local/bin/pi-mcp.kept" > /usr/local/bin/pi-mcp'
docker restart "$box" > /dev/null
pid_of() { root sh -c 'for p in /proc/[0-9]*; do case $(tr "\0" " " < "$p/cmdline" 2> /dev/null) in *"'"$1"'") echo "${p#/proc/}"; break ;; esac; done'; }
reasoner_running() { [ -n "$(pid_of '/apps/reasoner/src/main.ts once ')" ]; }
mcp_running() { [ -n "$(pid_of '/apps/pi/src/main.ts mcp ')" ]; }
must 'a reasoner run is in flight (the positive control)' wait_for 60 reasoner_running
must 'and the pi mcp it started' wait_for 20 mcp_running
rpid=$(pid_of '/apps/reasoner/src/main.ts once ')
mpid=$(pid_of '/apps/pi/src/main.ts mcp ')
is 'the run is the reasoner user' reasoner "$(root stat -c %U "/proc/$rpid")"
is "its environment, read as the reasoner, holds PATH, the wrapper's log switch and its file's four variables and nothing else" 'PATH PI_LOG_TIME PI_OPENROUTER_KEY_URL PI_REASONER_KEY_CAP_USD PI_REASONER_MODEL PI_REASONER_MODEL_KEY' "$(as_reasoner sh -c "tr '\0' '\n' < /proc/$rpid/environ" | sed 's/=.*//' | sort | tr '\n' ' ' | sed 's/ $//')"
mustnot 'pi cannot read it' as_pi cat "/proc/$rpid/environ"
mustnot 'nor agent' agent cat "/proc/$rpid/environ"
is 'the pi mcp it started runs as pimcp' pimcp "$(root stat -c %U "/proc/$mpid")"
mcp_env=$(as_pimcp sh -c "tr '\0' '\n' < /proc/$mpid/environ")
case $mcp_env in *PI_DATABASE_URL_READER=*) ok "the pi mcp's environment is read (the positive control)" ;; *) no "the pi mcp's environment is read (the positive control)" ;; esac
is 'and its key file is the narrowed copy' 1 "$(printf '%s\n' "$mcp_env" | grep -cx 'PI_KEY_FILE=/data/pimcp/keys.json')"
is 'and it holds no PI_REASONER name' 0 "$(printf '%s\n' "$mcp_env" | grep -c '^PI_REASONER')"
is 'nor the client token of any user but the reasoner' "$(root cat /data/pimcp/tokens/reasoner)" "$(printf '%s\n' "$mcp_env" | sed -n 's/^PI_CLIENT_TOKEN=//p')"
# Every process the timer started, read while the run is in flight: none is root but sudo,
# which is root only to change user. tail-config is the entrypoint's, root's until the node joins,
# and not the timer's: it and the sleep it waits in are left out.
tree=$(root sh -c 'for p in /proc/[0-9]*; do echo "${p#/proc/} $(awk "{print \$4}" "$p/stat" 2> /dev/null) $(stat -c %U "$p" 2> /dev/null) $(cat "$p/comm" 2> /dev/null)"; done' \
  | awk '{ up[$1] = $2; user[$1] = $3; comm[$1] = $4 } END { for (p in up) { q = up[p]; serve = comm[p] == "tail-config"; while (q != "" && q != "0" && q != "1") { if (comm[q] == "tail-config") serve = 1; q = up[q] } if (q == "1" && !serve) print p, user[p], comm[p] } }')
[ "$(printf '%s\n' "$tree" | grep -c .)" -ge 4 ] && ok "the timer's processes are read (the positive control)" || no "the timer's processes are read (the positive control, got '$tree')"
is 'no process the timer started runs as root, but sudo' '' "$(printf '%s\n' "$tree" | awk '$2 == "root" && $3 != "sudo"')"
must 'the run ends' wait_for 60 timer_asleep
root sh -c 'mv -f /usr/local/bin/pi-mcp.kept /usr/local/bin/pi-mcp && cat /run/reasoner-kept.env > /run/reasoner/reasoner.env && rm /run/reasoner-kept.env'
is 'the real pi-mcp is back, root-owned and closed to writes' 'root:755' "$(root stat -c '%U:%a' /usr/local/bin/pi-mcp)"

# A hold set while a sync runs: a stand-in for pi-sync that runs for a while. Neither the tick nor
# the reasoner starts after it.
root sh -c 'cp /usr/local/bin/pi-sync /usr/local/bin/pi-sync.kept && printf "%s\n" "#!/bin/sh" "sleep 15" > /usr/local/bin/pi-sync'
before=$(wruns)
rbefore=$(rruns)
docker restart "$box" > /dev/null
sync_stand_in() { root sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline" 2> /dev/null; echo; done' | grep -q '^sleep 15 $'; }
must 'the stand-in sync is running (the positive control)' wait_for 60 sync_stand_in
root touch /data/sync-hold
must 'the loop ends' wait_for 40 timer_asleep
is 'a hold set while a sync runs keeps the tick from starting after it' "$before" "$(wruns)"
is 'and the reasoner' "$rbefore" "$(rruns)"
root rm /data/sync-hold
root sh -c 'mv -f /usr/local/bin/pi-sync.kept /usr/local/bin/pi-sync'
is 'the real pi-sync is back, root-owned and closed to writes' 'root:755' "$(root stat -c '%U:%a' /usr/local/bin/pi-sync)"
# The read hold, which stays on after a restore whose first sync failed, stops the tick and the
# reasoner as it stops extraction: nothing acts on a restored database before a full sync.
before=$(wruns)
rbefore=$(rruns)
root pi-read-hold on
restart_box
is 'while the read hold exists, no tick starts' "$before" "$(wruns)"
is 'and no reasoner run' "$rbefore" "$(rruns)"
root pi-read-hold off
# The log is moved aside at about 5 MB, before the next run writes.
as_pi sh -c 'head -c 5000001 /dev/zero | tr "\0" x > /data/pi/work.log'
restart_box
must 'a work log at the size bound is moved aside' root test -f /data/pi/work.log.1
[ "$(root sh -c 'wc -c < /data/pi/work.log' 2> /dev/null || echo 9999999)" -lt 5000000 ] && ok 'and a new one is started' || no 'and a new one is started'
is 'the journal is still the one replay made' "$journal_inode" "$(root stat -c %i /data/pi/keys.json.erasures)"

echo '# a rotated model key'
# The box started again with a new key: the start replaces the stored one and says which it did,
# and a start with the same key again says only that it imported it.
start_codes() { docker logs "$box" 2>&1 | untimed | sed -n 's/^{"event":"box_start","code":"\(model_key_[a-z_]*\)"}$/\1/p' | tr '\n' ' ' | sed 's/ $//'; }
# The reasoner's refusals for an unreadable limit so far, counted before the box below starts.
unknown_lines() { root sh -c "grep '\"event\":\"spend_cap\"' /data/pi/work.log | grep -c '\"code\":\"spend_cap_unknown\"'"; }
unknown_before=$(unknown_lines)
docker rm -f "$box" > /dev/null
modelkey2="smoke-model-key-$(random)"
# This box is also given extraction's Anthropic key, a sentinel, and its effort, and the moment
# lane's model and effort. No extract runs here (extract-on is gone), so
# no model is called.
anthropickey="sk-ant-smoke-$(random)"
# Started as in production: the service's variables and no override of the key endpoint, on the
# smoke's network, which has no way out.
PI_OPENROUTER_KEY=$modelkey2 PI_EXTRACT_ANTHROPIC_KEY=$anthropickey PI_EXTRACT_EFFORT=low PI_EXTRACT_MOMENT_MODEL=anthropic/claude-sonnet-5-5 PI_EXTRACT_MOMENT_EFFORT=medium docker run -d --name "$box" --network "$net" -v "$vol:/data" -e PI_DATABASE_URL_RESTRICTED \
  -e PI_DATABASE_URL_ADMIN -e PI_DATABASE_URL_WRITER -e PI_DATABASE_URL_READER -e PI_DATABASE_URL_PIPELINE -e PI_DATABASE_URL_WORK -e PI_EXTRACT_MODEL -e PI_GOOGLE_CLIENT_ID -e PI_GOOGLE_CLIENT_SECRET -e PI_OPENROUTER_KEY -e PI_REASONER_MODEL -e PI_REASONER_MODEL_KEY -e PI_DATABASE_URL_PROXY -e PI_SEND_GOOGLE_CLIENT_ID -e PI_SEND_GOOGLE_CLIENT_SECRET -e PI_DATABASE_URL_NOTIFY \
  -e PI_EXTRACT_ANTHROPIC_KEY -e PI_EXTRACT_EFFORT -e PI_EXTRACT_MOMENT_MODEL -e PI_EXTRACT_MOMENT_EFFORT \
  "$image" > /dev/null
must 'the box starts with a new model key' wait_for 60 ready
is 'the start says the stored key was replaced' model_key_replaced "$(start_codes)"
docker restart "$box" > /dev/null
replaced_then_imported() { [ "$(start_codes)" = 'model_key_replaced model_key_imported' ]; }
must 'started again with the same key, it says imported' wait_for 60 replaced_then_imported
must 'the container log still holds nothing but fixed lines' only_fixed_lines
mustnot 'and not the new model key' sh -c "docker logs '$box' 2>&1 | grep -qF '$modelkey2'"
mustnot 'nor does the sync log' root grep -qF "$modelkey2" /data/pi/sync.log
# HO5: a box started as in production names no override of the key endpoint, in its log or its
# files, and with no ceiling set its files hold none.
must 'started as in production, the box starts' start_code "$box" ready
mustnot 'and logs no key_url_override line' sh -c "docker logs '$box' 2>&1 | grep -q key_url_override"
mustnot 'and no file the box wrote names PI_OPENROUTER_KEY_URL' root grep -rq PI_OPENROUTER_KEY_URL /run/pi /run/reasoner /run/pisend
is 'extract.env holds no ceiling when none is set, and the Anthropic key, the effort and the moment pair when they are' 'PI_DATABASE_URL_PIPELINE PI_KEY_FILE PI_EXTRACT_MODEL PI_EXTRACT_ANTHROPIC_KEY PI_EXTRACT_EFFORT PI_EXTRACT_MOMENT_MODEL PI_EXTRACT_MOMENT_EFFORT' "$(root sed 's/=.*//' /run/pi/extract.env | tr '\n' ' ' | sed 's/ $//')"
must 'and the moment pair in it is the one the service set' root sh -c "grep -qx 'PI_EXTRACT_MOMENT_MODEL=anthropic/claude-sonnet-5-5' /run/pi/extract.env && grep -qx 'PI_EXTRACT_MOMENT_EFFORT=medium' /run/pi/extract.env"
must 'extract.env and no other file the box wrote holds the moment pair' root sh -c "out=\$(grep -rlE 'PI_EXTRACT_MOMENT_(MODEL|EFFORT)' /run/pi /run/reasoner /run/pisend) && [ \"\$out\" = /run/pi/extract.env ]"
must 'and the Anthropic key in it is the one the service set' root grep -qxF "PI_EXTRACT_ANTHROPIC_KEY=$anthropickey" /run/pi/extract.env
must 'extract.env and no other file the box wrote holds the Anthropic key' root sh -c "out=\$(grep -rlF '$anthropickey' /run/pi /run/reasoner /run/pisend) && [ \"\$out\" = /run/pi/extract.env ]"
mustnot 'agent cannot read extract.env' agent cat /run/pi/extract.env
mustnot 'the container log does not hold the Anthropic key' sh -c "docker logs '$box' 2>&1 | grep -qF '$anthropickey'"
is 'nor reasoner.env' 'PI_REASONER_MODEL PI_REASONER_MODEL_KEY' "$(root sed 's/=.*//' /run/reasoner/reasoner.env | tr '\n' ' ' | sed 's/ $//')"
# With OpenRouter's own endpoint and no way out, the reasoner's check cannot read the limit: it
# refuses its run, fail-closed, and no request has left the machine.
refused_unknown() { [ "$(unknown_lines)" -gt "$unknown_before" ]; }
must 'and the reasoner, which cannot reach the key endpoint, refuses its run spend_cap_unknown' wait_for 90 refused_unknown

echo '# the send user'
# The timer is held throughout: a label is made connected below, and no sync may ever reach Google
# with it.
root touch /data/sync-hold
wait_for 60 timer_asleep
is 'the send user has fixed ids, no home and no shell' 'pisend 902 902 /nonexistent /usr/sbin/nologin' "$(root getent passwd pisend | awk -F: '{print $1, $3, $4, $6, $7}')"
is 'it is in no group but its own' pisend "$(as_pisend id -Gn)"
is 'and owns nothing on the volume' '' "$(root find /data -user pisend -print | head -n 1)"
is 'pi-send is root-owned, mode 700, and its loader root-owned, mode 755' 'root:700 root:755' "$(root stat -c '%U:%a' /usr/local/bin/pi-send /usr/local/lib/pi/send-run | tr '\n' ' ' | sed 's/ $//')"
mustnot 'no sudo rule names pisend, pi-send or its loader' root grep -rqE 'pisend|pi-send|send-run' /etc/sudoers /etc/sudoers.d

mustnot 'agent cannot run pi-send' agent /usr/local/bin/pi-send send status
mustnot 'the reasoner cannot run pi-send' as_reasoner /usr/local/bin/pi-send send status
mustnot 'nor can pi' as_pi /usr/local/bin/pi-send send status
must 'sudo refuses agent pi-send' sudo_refuses /usr/local/bin/pi-send send status
must 'sudo refuses agent a shell as pisend' sudo_refuses -u pisend /bin/sh
must 'sudo refuses the reasoner pi-send' refused_by_sudo as_reasoner sudo -n /usr/local/bin/pi-send send status
must 'sudo refuses the reasoner a shell as pisend' refused_by_sudo as_reasoner sudo -n -u pisend /bin/sh
must 'sudo refuses pi pi-send' refused_by_sudo as_pi sudo -n /usr/local/bin/pi-send send status
must 'sudo refuses pi a shell as pisend' refused_by_sudo as_pi sudo -n -u pisend /bin/sh
must 'pisend reads send.env (the positive control)' as_pisend grep -qF "$proxypw" /run/pisend/send.env
mustnot 'pi cannot read send.env' as_pi cat /run/pisend/send.env
mustnot 'nor list /run/pisend' as_pi ls /run/pisend
for path in /data/pi/keys.json /data/pi/keys.json.erasures /run/pi/admin.env /run/pi/sync.env /run/pimcp/mcp.env /run/pi/extract.env /run/pi/work.env /run/reasoner/reasoner.env /data/pimcp/tokens/agent /data/pimcp/tokens/root /data/pimcp/tokens/reasoner /data/agent/.claude.json; do
  must "root reads $path (the positive control)" root cat "$path"
  mustnot "pisend cannot read $path" as_pisend cat "$path"
done
for path in /data/pi /data/pimcp /data/agent /run/pi /run/pimcp /run/reasoner; do
  mustnot "pisend cannot list $path" as_pisend ls "$path"
done
mustnot "pisend cannot read a pi process's environment" as_pisend cat /proc/1/environ

# Root keeps each file in its own directory and puts it back.
plant() { printf '%s\n' "$2" | root sh -c 'cp -p "$1" /run/pi-root/planted.kept && cat >> "$1"' plant "$1"; }
unplant() { root sh -c 'cat /run/pi-root/planted.kept > "$1" && rm /run/pi-root/planted.kept' unplant "$1"; }
refused_role() { "$@" < /dev/null 2>&1 | grep -qF '"code":"wrong_role_url"'; }
wrapper_refuses() {
  local file=$1
  shift
  mustnot "$1 starts with its own file (the positive control)" refused_role root "$@"
  for line in "PI_DATABASE_URL_PROXY=$PI_DATABASE_URL_PROXY" "PI_SEND_GOOGLE_CLIENT_SECRET=$sendsecret"; do
    plant "$file" "$line"
    must "$1 refuses ${line%%=*} planted in $file" refused_role root "$@"
    unplant "$file"
  done
}
wrapper_refuses /run/pi/admin.env pi-admin status
wrapper_refuses /run/pi/sync.env pi-sync sync
wrapper_refuses /run/pimcp/mcp.env pi-mcp
wrapper_refuses /run/pi/extract.env pi-extract extract
wrapper_refuses /run/pi/work.env pi-work work tick
send_status() { root pi-send send status < /dev/null; }
is 'pi-send send status runs as pisend with the proxy URL and exits 0 (the positive control)' 0 "$(send_status > /dev/null 2>&1; echo $?)"
for line in "PI_DATABASE_URL_ADMIN=$PI_DATABASE_URL_ADMIN" "PI_DATABASE_URL_READER=$PI_DATABASE_URL_READER" "PI_DATABASE_URL_PIPELINE=$PI_DATABASE_URL_PIPELINE"; do
  plant /run/pisend/send.env "$line"
  must "pi-send refuses ${line%%=*} planted in send.env" refused_role send_status
  unplant /run/pisend/send.env
done

# S11: the copies are gone when a send command has ended. One an earlier run left is removed first,
# else the entry, which never writes over a file, would refuse.
copies_gone() { ! root sh -c 'test -e /run/pisend/keys.json || test -e /run/pisend/keys.json.erasures'; }
must 'after a send command has ended the copies are gone' copies_gone
root sh -c 'touch /run/pisend/keys.json /run/pisend/keys.json.erasures'
is 'a copy an earlier run left is removed before the new one is made' 0 "$(send_status > /dev/null 2>&1; echo $?)"
must 'and none is left after' copies_gone
# A copy that cannot be made: no key file. Nothing runs as pisend, and nothing is left.
as_pi mv /data/pi/keys.json /data/pi/keys.json.kept
is 'with no key file pi-send exits 1 with copy_failed' '1 {"event":"pi_send","code":"copy_failed"}' "$(out=$(send_status 2>&1); echo "$? $out")"
must 'and leaves no copy' copies_gone
as_pi mv /data/pi/keys.json.kept /data/pi/keys.json

# A connected label for send connect to wait on: an own mail account, written as pi with the store's
# own code so its address is sealed under own, and a read secret, of which read_connected asks the
# name alone. No sync runs while the hold is set, and both are gone before it is lifted.
for compartment in public employer:example agent:one agent:two; do root pia keys add-compartment "$compartment"; done
# pia handed the agent API its narrowed key file after each: every agent key and public, and not
# the employer's compartment, which no client holds.
compartments_of() { root node -e 'process.stdout.write(Object.keys(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).compartments).sort().join(" "))' "$1"; }
is "the agent API's key file holds own, public and the agent keys, and no employer's" 'agent:one agent:two own public' "$(compartments_of /data/pimcp/keys.json)"
must "while pi's holds the employer's (the positive control)" sh -c "docker exec '$box' node -e 'process.exit(JSON.parse(require(\"node:fs\").readFileSync(\"/data/pi/keys.json\", \"utf8\")).compartments[\"employer:example\"] ? 0 : 1)'"
seed='import { readFileSync } from "node:fs";
import { createWriter, loadKeys } from "/opt/intelligence/packages/store/src/index.ts";
const env = {};
for (const line of readFileSync("/run/pi/sync.env", "utf8").split("\n")) { const at = line.indexOf("="); if (at > 0) env[line.slice(0, at)] = line.slice(at + 1); }
const log = { info() {}, warn() {}, error() {} };
const writer = createWriter({ url: env.PI_DATABASE_URL_WRITER, keys: await loadKeys(env.PI_KEY_FILE), log });
await writer.ensureSourceAccount("smoke", "google_mail", "own", "owner@example.com");
await writer.close();'
must 'an own mail account for the label smoke' as_pi env -i PATH=/usr/local/bin:/usr/bin:/bin node --input-type=module -e "$seed"
docker exec "$pg" psql -U postgres -c "insert into policy.secrets (name, value_enc) values ('google/smoke/refresh_token', '{}')" pi > /dev/null
# A journal that is not empty, so its copy is compared on something; put back to empty below.
as_pi sh -c 'printf "%s\n" "{\"smoke\":1}" >> /data/pi/keys.json.erasures'
( root timeout 60 pi-send send connect --account smoke --port 8767 < /dev/null > "$tmp/connect.out" 2> "$tmp/connect.err" ) &
connect_pid() { pid_of '/apps/pi/src/main.ts send connect --account smoke --port 8767 '; }
connecting() { [ -n "$(connect_pid)" ] && grep -q '^https://' "$tmp/connect.out"; }
must 'pi-send send connect waits for its browser (the positive control)' wait_for 60 connecting
spid=$(connect_pid)
case $(head -n 1 "$tmp/connect.out") in
  https://accounts.google.com/*client_id=smoke-send-client-id*) ok 'the consent URL it prints names the send client' ;;
  *) no 'the consent URL it prints names the send client' ;;
esac
cmdlines=$(root sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline" 2> /dev/null; echo; done')
case $cmdlines in *'main.ts send connect'*) ok 'every command line is read (the positive control)' ;; *) no 'every command line is read (the positive control)' ;; esac
is 'no command line holds the proxy URL or the send secret while it waits' 0 "$(printf '%s\n' "$cmdlines" | grep -cF -e "$proxypw" -e "$sendsecret")"
is 'the send process runs as pisend' pisend "$(root stat -c %U "/proc/$spid")"
must 'pisend reads its environment, which holds the send secret (the positive control)' as_pisend grep -qaF "$sendsecret" "/proc/$spid/environ"
mustnot "pi cannot read the send process's environment" as_pi cat "/proc/$spid/environ"
mustnot 'nor agent' agent cat "/proc/$spid/environ"
mustnot 'nor the reasoner' as_reasoner cat "/proc/$spid/environ"
send_env=$(as_pisend sh -c "tr '\0' '\n' < /proc/$spid/environ")
is "its environment holds the send variables, the copy and the wrapper's log switch, and no other PI_ name" 'PI_DATABASE_URL_PROXY PI_KEY_FILE PI_LOG_TIME PI_SEND_GOOGLE_CLIENT_ID PI_SEND_GOOGLE_CLIENT_SECRET' "$(printf '%s\n' "$send_env" | sed -n 's/^\(PI_[A-Z_]*\)=.*/\1/p' | sort | tr '\n' ' ' | sed 's/ $//')"
is 'its key file is the copy' 1 "$(printf '%s\n' "$send_env" | grep -cx 'PI_KEY_FILE=/run/pisend/keys.json')"
is "and it holds nothing of the superuser's" 0 "$(printf '%s\n' "$send_env" | grep -c -e '^PG' -e "$super")"
# Names only: no key is printed.
names() { root node -e 'const f = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const keep = process.argv[2] === "sending" ? (n) => n === "own" || n.startsWith("agent:") : () => true; console.log([...Object.keys(f.compartments).filter(keep).sort(), typeof f.fingerprint === "string" && typeof f.fingerprintCheck === "string" ? "fingerprint" : "no-fingerprint"].join(" "))' "$@"; }
is "the key file holds more than sending needs (the positive control)" 'agent:one agent:two employer:example own public fingerprint' "$(names /data/pi/keys.json)"
is "the key copy's names are own and the key file's agent: names, with the fingerprint key" "$(names /data/pi/keys.json sending)" "$(names /run/pisend/keys.json)"
is 'the copies are pisend:pisend 600' 'pisend:pisend 600 pisend:pisend 600' "$(root stat -c '%U:%G %a' /run/pisend/keys.json /run/pisend/keys.json.erasures | tr '\n' ' ' | sed 's/ $//')"
must 'the journal copy is the journal' root cmp -s /data/pi/keys.json.erasures /run/pisend/keys.json.erasures
must 'which is not empty (the positive control)' root test -s /run/pisend/keys.json.erasures
is 'the key file and the journal are still pi:pi 600' 'pi:pi 600 pi:pi 600' "$(root stat -c '%U:%G %a' /data/pi/keys.json /data/pi/keys.json.erasures | tr '\n' ' ' | sed 's/ $//')"
must 'pisend reads its copy (the positive control)' as_pisend cat /run/pisend/keys.json
for who in as_pi agent as_reasoner; do
  mustnot "$who cannot read the key copy" "$who" cat /run/pisend/keys.json
done
# S16: one send command at a time; a second leaves the first's copies alone.
is 'a second pi-send while one waits exits 1 with busy' '1 {"event":"pi_send","code":"busy"}' "$(out=$(send_status 2>&1); echo "$? $out")"
must "and the first's copies are still there" root sh -c 'test -s /run/pisend/keys.json && test -s /run/pisend/keys.json.erasures'
# S11: ended by a signal, as a dropped session ends it: a hangup to its process group.
root sh -c 'for p in /proc/[0-9]*; do case $(tr "\0" " " < "$p/cmdline" 2> /dev/null) in "/bin/sh /usr/local/bin/pi-send send connect "*) kill -HUP -"$(awk "{print \$5}" "$p/stat")"; break ;; esac; done'
wait
connect_running() { [ -n "$(connect_pid)" ]; }
mustnot 'the send process has ended' connect_running
must 'and its copies are gone after a signal' copies_gone
is 'the lock went with it: the next send command runs' 0 "$(send_status > /dev/null 2>&1; echo $?)"
# S12: after a start, a migration and send commands, the proxy password and the send secret are only
# in send.env, and send.env is named in four installed files and no other.
is 'no file under /run/pi, /run/reasoner or /data holds the proxy password or the send secret' '' "$(root grep -rlF -e "$proxypw" -e "$sendsecret" /run/pi /run/reasoner /data | head -n 3)"
is 'send.env holds both (the positive control)' /run/pisend/send.env "$(root grep -rlF -e "$proxypw" /run/pisend)"
is 'send.env is named in four installed files and no other' '/usr/local/bin/pi-migrate /usr/local/bin/pi-send /usr/local/lib/pi/entrypoint /usr/local/lib/pi/send-run' "$(root grep -rl 'send\.env' /usr/local/bin /usr/local/lib/pi | sort | tr '\n' ' ' | sed 's/ $//')"
# A wrapper killed outright, which no trap can see: its send command still holds the turn, so a
# second run cannot remove the copies under it. Once the command has ended, the next run removes
# what the killed wrapper left.
( root timeout 60 pi-send send connect --account smoke --port 8767 < /dev/null > "$tmp/connect.out" 2> "$tmp/connect.err" ) &
must 'a second send connect waits for its browser (the positive control)' wait_for 60 connecting
root sh -c 'for p in /proc/[0-9]*; do case $(tr "\0" " " < "$p/cmdline" 2> /dev/null) in "/bin/sh /usr/local/bin/pi-send send connect "*) kill -KILL "${p#/proc/}"; break ;; esac; done'
sleep 1
must 'with its wrapper killed outright, the send command still runs (the positive control)' connect_running
is 'and a second pi-send exits 1 with busy' '1 {"event":"pi_send","code":"busy"}' "$(out=$(send_status 2>&1); echo "$? $out")"
must "and the command's copies are still there" root sh -c 'test -s /run/pisend/keys.json && test -s /run/pisend/keys.json.erasures'
root sh -c "kill $(connect_pid)"
wait
connect_ended() { ! connect_running; }
wait_for 20 connect_ended
is 'once it has ended, the next pi-send runs' 0 "$(send_status > /dev/null 2>&1; echo $?)"
must 'and leaves no copy behind' copies_gone
# The entrypoint removes a copy a killed run left, at each start.
root sh -c 'touch /run/pisend/keys.json /run/pisend/keys.json.erasures'
restart_box
must 'a start removes copies a killed run left' copies_gone
# Put back: the journal empty again, which owner commands read first, the label disconnected, the
# hold lifted.
as_pi sh -c ': > /data/pi/keys.json.erasures'
must 'pia google disconnect smoke' root pia google disconnect smoke
root rm /data/sync-hold

echo '# the work-notice sender'
# The work-notice sender's checks, each with root or pinotify as its positive control.
notify_pid() { pid_of '/apps/pi/src/main.ts notify '; }
notify_sweeps() { root grep -q '"event":"notify_sweep"' /data/pinotify/notify.log; }
must 'once pi_notify can log in, the supervised sender sweeps' wait_for 120 notify_sweeps
notify_running() { [ -n "$(notify_pid)" ]; }
must 'the sender runs' wait_for 30 notify_running
npid=$(notify_pid)
is 'as pinotify' pinotify "$(root stat -c %U "/proc/$npid")"
is "its environment holds its two variables and the wrapper's log switch, and no other PI_ name" 'PI_DATABASE_URL_NOTIFY PI_LOG_TIME PI_WEBHOOK_SECRETS' "$(as_pinotify sh -c "tr '\0' '\n' < /proc/$npid/environ" | sed -n 's/^\(PI_[A-Z_]*\)=.*/\1/p' | sort | tr '\n' ' ' | sed 's/ $//')"
for who in as_pi agent as_reasoner; do
  mustnot "$who cannot read the sender's environment" "$who" cat "/proc/$npid/environ"
done
is 'no command line holds the notify password' 0 "$(root sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline" 2> /dev/null; echo; done' | grep -cF "$notifypw")"
# pinotify reads none of pi's files, the reasoner's, the send user's or agent's.
for path in /data/pi/keys.json /data/pi/keys.json.erasures /run/pi/admin.env /run/pi/work.env /run/reasoner/reasoner.env /run/pisend/send.env /data/pimcp/tokens/agent /data/pimcp/tokens/root /data/agent/.claude.json; do
  mustnot "pinotify cannot read $path" as_pinotify cat "$path"
done
for path in /run/pi /run/pimcp /data/pi /data/pimcp /run/pisend /run/reasoner /data/agent; do
  mustnot "pinotify cannot list $path" as_pinotify ls "$path"
done
# `pi notify` refuses a key file, a client token or another role's URL in its environment, and
# every other command refuses the notify URL, the wrappers' own files included.
notify_with() { as_pinotify env -i PATH=/usr/local/bin:/usr/bin:/bin "PI_DATABASE_URL_NOTIFY=$PI_DATABASE_URL_NOTIFY" PI_WEBHOOK_SECRETS=/data/pinotify/webhooks.json "$@" /usr/local/bin/pi notify < /dev/null 2>&1; }
for extra in PI_KEY_FILE=/data/pi/keys.json PI_CLIENT_TOKEN=pi_smoke "PI_DATABASE_URL_READER=$PI_DATABASE_URL_READER" "PI_DATABASE_URL_PROXY=$PI_DATABASE_URL_PROXY"; do
  is "pi notify with ${extra%%=*} set exits 1 with wrong_role_url" '1 {"event":"command_failed","code":"wrong_role_url"}' "$(out=$(notify_with "$extra"); echo "$? $out" | head -n 1)"
done
is 'pi-notify running another command exits 1 with wrong_role_url' '1 {"event":"command_failed","code":"wrong_role_url"}' "$(out=$(root pi-notify status < /dev/null 2>&1); echo "$? $out" | head -n 1 | untimed)"
notify_planted() {
  local file=$1
  shift
  plant "$file" "PI_DATABASE_URL_NOTIFY=$PI_DATABASE_URL_NOTIFY"
  must "$1 refuses PI_DATABASE_URL_NOTIFY planted in $file" refused_role root "$@"
  unplant "$file"
}
notify_planted /run/pi/admin.env pi-admin status
notify_planted /run/pi/sync.env pi-sync sync
notify_planted /run/pimcp/mcp.env pi-mcp
notify_planted /run/pi/extract.env pi-extract extract
notify_planted /run/pi/work.env pi-work work tick
mustnot 'pi-notify refuses agent by its mode' agent /usr/local/bin/pi-notify notify
mustnot 'and pi' as_pi /usr/local/bin/pi-notify notify
must 'sudo refuses agent pi-notify' sudo_refuses /usr/local/bin/pi-notify notify
must 'sudo refuses agent a shell as pinotify' sudo_refuses -u pinotify /bin/sh

# The pia wrapper's key step. The webhook's host resolves to a documentation address, as
# a public one; the box has no way out, so nothing reaches it. Each key is typed at a terminal
# script gives the wrapper, a moment after it starts, as the owner types it.
root sh -c 'printf "%s\n" "203.0.113.7 hook.example.org" >> /etc/hosts'
must 'an agent for the webhook' root sh -c 'pi-admin clients add smoke-hook --views self --tools get_self --runtime local > /dev/null'
hook='pia clients webhook set smoke-hook https://hook.example.org/pi-notice'
typed() { { sleep 5; printf '%s\n' "$1"; } | root script -qec "$2" /dev/null 2>&1; }
hookkey="smoke-routine-key-$(random)"
hooked=$(typed "$hookkey" "$hook"); hooked_status=$?
is 'pia clients webhook set with a key typed exits 0' 0 "$hooked_status"
case $hooked in *'"client":"cli_'*) ok 'and prints the client id' ;; *) no "and prints the client id (got '$hooked')" ;; esac
mustnot 'and never prints the key it was given' sh -c "printf '%s' '$hooked' | grep -qF '$hookkey'"
is 'webhooks.json is pinotify:pinotify 600' 'pinotify:pinotify 600' "$(root stat -c '%U:%G %a' /data/pinotify/webhooks.json)"
hookid=$(printf '%s' "$hooked" | grep -o 'cli_[0-9A-Z]*' | head -n 1)
is 'it holds the key under the client id and nothing else' "{\"$hookid\":\"$hookkey\"}" "$(root cat /data/pinotify/webhooks.json)"
must 'pia clients list says the agent has a webhook' sh -c "docker exec '$box' pia clients list | grep -q '\"name\":\"smoke-hook\"[^}]*\"webhook\":true'"
must 'pinotify reads the key file (the positive control)' as_pinotify cat /data/pinotify/webhooks.json
for who in as_pi agent as_reasoner as_pisend; do
  mustnot "$who cannot read the key file" "$who" cat /data/pinotify/webhooks.json
done
is 'the sender read the new file without a restart' "$npid" "$(notify_pid)"
is 'no environment file, nothing of pi or agent on the volume and no log holds the key' '' "$(root grep -rlF "$hookkey" /run /data/pi /data/agent /data/pinotify/notify.log | head -n 3)"
is 'nor the box output' 0 "$(docker logs "$box" 2>&1 | grep -cF "$hookkey")"
is "nor the sender's environment" 0 "$(as_pinotify grep -caF "$hookkey" "/proc/$npid/environ")"
for bad in short-key 'with a space in it ok' "$(printf 'x%.0s' $(seq 513))"; do
  refused_out=$(typed "$bad" "$hook"); refused_status=$?
  is 'a key that is not 16 to 512 visible ASCII characters is refused, running nothing' '1 1' "$refused_status $(printf '%s' "$refused_out" | grep -c 'refused: a webhook key')"
done
is 'and the stored key is unchanged' "{\"$hookid\":\"$hookkey\"}" "$(root cat /data/pinotify/webhooks.json)"
made_out=$(typed '' "$hook"); made_status=$?
madekey=$(printf '%s' "$made_out" | tr -d '\r' | sed -n 's/^webhook key, shown once: \([0-9a-f]\{64\}\)$/\1/p')
is 'with no key typed it makes one, exits 0 and shows it once' '0 1' "$made_status $(printf '%s' "$made_out" | grep -c 'shown once')"
is 'and stores that key in place of the old one' "{\"$hookid\":\"$madekey\"}" "$(root cat /data/pinotify/webhooks.json)"
is 'pia clients webhook rm exits 0' 0 "$(root pia clients webhook rm smoke-hook > /dev/null 2>&1; echo $?)"
is 'and removes the key' '{}' "$(root cat /data/pinotify/webhooks.json)"
typed "$hookkey" "$hook" > /dev/null
is 'set again (the positive control)' "{\"$hookid\":\"$hookkey\"}" "$(root cat /data/pinotify/webhooks.json)"
is 'pia clients revoke exits 0' 0 "$(root pia clients revoke smoke-hook > /dev/null 2>&1; echo $?)"
is 'and removes the key with the client' '{}' "$(root cat /data/pinotify/webhooks.json)"
is 'a webhook for a revoked agent is refused, and writes nothing' 'refused {}' "$(if typed "$hookkey" "$hook" > /dev/null; then echo set; else echo refused; fi) $(root cat /data/pinotify/webhooks.json)"
is 'notify.env is named in five installed files and no other' '/usr/local/bin/pi-migrate /usr/local/bin/pi-notify /usr/local/lib/pi/entrypoint /usr/local/lib/pi/notify-run /usr/local/lib/pi/notify-serve' "$(root grep -rl 'notify\.env' /usr/local/bin /usr/local/lib/pi | sort | tr '\n' ' ' | sed 's/ $//')"
is 'webhooks.json is named in the entrypoint, for notify.env, and the pia wrapper, which writes it, and no other installed file' '/usr/local/bin/pi-admin /usr/local/lib/pi/entrypoint' "$(root grep -rl 'webhooks\.json' /usr/local/bin /usr/local/lib/pi | sort | tr '\n' ' ' | sed 's/ $//')"

echo '# the database made again, as after a loss: the roles are still on the server'
docker exec "$pg" dropdb --force -U postgres pi
must 'pi-db-init makes the database again' sh -c "printf 'postgres\n%s\n' '$super' | docker exec -i '$box' pi-db-init"
is 'pi-migrate applies the schema again beside the roles that exist' 'bootstrap can log in: false 0' "$(migrate_result)"
must 'pi-admin status answers on the new database' root pi-admin status
is 'and a client token from before is refused' '{"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"unauthorized"}}' "$(printf '%s\n' "$init" | agent /usr/local/bin/pi-mcp 2> /dev/null)"

echo '# without its variables'
docker rm -f "$box" > /dev/null
docker run -d --name "$box" --network "$net" -v "$vol:/data" "$image" > /dev/null
wait_for 30 root test -f /run/pimcp/mcp.env
# Neither PI_HTTP_BASE_URL nor PI_HTTP_ENABLED: the endpoint is off.
must 'with neither, the start says http_off' start_code "$box" http_off
mustnot 'and writes no http.env' root test -e /run/pihttp/http.env
mustnot 'and no pi http runs' sh -c "docker exec '$box' sh -c 'for p in /proc/[0-9]*; do tr \"\\0\" \" \" < \$p/cmdline 2> /dev/null; echo; done' | grep -q 'main.ts http '"
# A required one is missing_env, an optional one (the proxy, restricted and
# notify URLs, and the dead-man check's) optional_unset, each with its name.
is 'the box starts, and names each missing variable' 13 "$(( $(start_count "$box" missing_env) + $(start_count "$box" optional_unset) ))"
must 'the notify URL among them' start_code "$box" optional_unset PI_DATABASE_URL_NOTIFY
mustnot 'and with no notify URL there is no notify.env' root test -e /run/pinotify/notify.env
mustnot 'and no notify supervisor runs' notify_supervised
must 'the proxy URL among them' start_code "$box" optional_unset PI_DATABASE_URL_PROXY
must "the dead-man check's URL among them" start_code "$box" optional_unset PI_HEARTBEAT_URL
must 'the pipeline URL among them' start_code "$box" missing_env PI_DATABASE_URL_PIPELINE
must 'and the work URL' start_code "$box" missing_env PI_DATABASE_URL_WORK
must "and the reasoner's model" start_code "$box" missing_env PI_REASONER_MODEL
must "and the reasoner's key" start_code "$box" missing_env PI_REASONER_MODEL_KEY
must 'and the restricted URL' start_code "$box" optional_unset PI_DATABASE_URL_RESTRICTED
mustnot 'and with no restricted URL there is no restricted.env' root test -e /run/pirestricted/restricted.env
mustnot 'and with no pipeline URL there is no extract.env' root test -e /run/pi/extract.env
root touch /data/extract-on
before=$(xruns)
restart_box
is 'with no extract.env no extract starts, even with extract-on' "$before" "$(xruns)"
root rm /data/extract-on
is 'and a command says which one it lacks' 'set PI_DATABASE_URL_ADMIN' "$(root pi-admin status 2>&1 | grep -v agent_keys_failed | tail -n 1)"
must "and pia's agent key step says, in a fixed line, that it could not make the copy" sh -c "docker exec '$box' pi-admin status 2>&1 | grep -qx '{\"event\":\"agent_keys_failed\",\"code\":\"keys\"}'"
mustnot 'without PI_OPENROUTER_KEY there is no model key file' root test -e /run/pi/model-key.env

# Started as another user the entrypoint refuses: it cannot give the files to pi.
docker run -d --name "$notroot" --user agent --network none "$image" > /dev/null
sleep 5
is 'not started as root, the box says so' '{"event":"box_start","code":"not_root"}' "$(docker logs "$notroot" 2>&1 | head -n 1 | untimed)"
is 'and does not start' false "$(docker inspect -f '{{.State.Running}}' "$notroot")"
# With no volume the box must stop by itself. It is started detached and looked at after a
# moment, so a box that wrongly kept running fails the check and is still removed at the end.
docker run -d --name "$novol" --network none "$image" > /dev/null
sleep 5
is 'with no volume at /data the box says so' '{"event":"box_start","code":"no_volume"}' "$(docker logs "$novol" 2>&1 | head -n 1 | untimed)"
is 'and does not start' false "$(docker inspect -f '{{.State.Running}}' "$novol")"

# A value with a line break must not add lines to a file: here a budget value that carries an
# admin URL of its own, which pi-migrate would otherwise pass to the migration.
docker run -d --name "$badenv" --network none --tmpfs /data -e PI_DATABASE_URL_PIPELINE -e "PI_EXTRACT_RUN_USD=1
PI_DATABASE_URL_ADMIN=postgres://pi_admin:smoke-injected@$pg:5432/pi" -e PI_HTTP_TRUST_PROXY=yes "$image" > /dev/null
wait_for 30 docker exec "$badenv" test -f /run/pi/extract.env
is 'a value with a line break is left out of extract.env' 'PI_DATABASE_URL_PIPELINE PI_KEY_FILE' "$(docker exec "$badenv" sed 's/=.*//' /run/pi/extract.env | tr '\n' ' ' | sed 's/ $//')"
must 'and named in the log' start_code "$badenv" bad_env PI_EXTRACT_RUN_USD
must 'a box started with no endpoint setting says http_off' start_code "$badenv" http_off
must 'a proxy switch that is not 1 is named, not passed on' start_code "$badenv" bad_env PI_HTTP_TRUST_PROXY
mustnot 'and with the endpoint off the start does not warn of the proxy' start_code "$badenv" http_trust_proxy_unset

# S13. A send credential aimed at a file of /run/pi is left out of it and named, after a bad_env
# line: here the entrypoint, changed to put the proxy URL and the send secret in mcp.env, as a
# careless edit might. The change is made to a copy in the container, which then runs it.
docker run -d --name "$sendenv" --network none --tmpfs /data -e PI_DATABASE_URL_PROXY -e PI_SEND_GOOGLE_CLIENT_SECRET -e PI_DATABASE_URL_NOTIFY --entrypoint /bin/sh "$image" \
  -c "sed 's|^write /run/pimcp/mcp.env root:pimcp |write /run/pimcp/mcp.env root:pimcp \"PI_DATABASE_URL_PROXY=\${PI_DATABASE_URL_PROXY}\" \"PI_SEND_GOOGLE_CLIENT_SECRET=\${PI_SEND_GOOGLE_CLIENT_SECRET}\" \"PI_DATABASE_URL_NOTIFY=\${PI_DATABASE_URL_NOTIFY}\" \"PI_WEBHOOK_SECRETS=/data/pinotify/webhooks.json\" |' /usr/local/lib/pi/entrypoint > /run/planted-entrypoint && exec /bin/sh /run/planted-entrypoint" > /dev/null
wait_for 30 docker exec "$sendenv" test -f /run/pimcp/mcp.env
must 'the changed entrypoint aims the send lines at mcp.env (the positive control)' docker exec "$sendenv" grep -q '^write /run/pimcp/mcp.env root:pimcp "PI_DATABASE_URL_PROXY=' /run/planted-entrypoint
is 'write leaves them out of mcp.env' 'PI_DATABASE_URL_READER PI_KEY_FILE' "$(docker exec "$sendenv" sed 's/=.*//' /run/pimcp/mcp.env | tr '\n' ' ' | sed 's/ $//')"
must 'and still writes the URL to send.env (the positive control)' docker exec "$sendenv" grep -qxF "PI_DATABASE_URL_PROXY=$PI_DATABASE_URL_PROXY" /run/pisend/send.env
must 'each is named in a bad_env line: the proxy URL' start_code "$sendenv" bad_env PI_DATABASE_URL_PROXY
must 'and the send secret' start_code "$sendenv" bad_env PI_SEND_GOOGLE_CLIENT_SECRET
must "the notify variables, aimed at mcp.env, are named too" sh -c "docker logs '$sendenv' 2>&1 | grep -q '\"code\":\"bad_env\",\"name\":\"PI_DATABASE_URL_NOTIFY\"' && docker logs '$sendenv' 2>&1 | grep -q '\"code\":\"bad_env\",\"name\":\"PI_WEBHOOK_SECRETS\"'"
must 'and the entrypoint still writes the notify URL to notify.env (the positive control)' docker exec "$sendenv" grep -qxF "PI_DATABASE_URL_NOTIFY=$PI_DATABASE_URL_NOTIFY" /run/pinotify/notify.env
mustnot 'and no value reaches the log' sh -c "docker logs '$sendenv' 2>&1 | grep -qF -e '$proxypw' -e '$sendsecret' -e '$notifypw'"

echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
