# Read by pi-db-init and pi-migrate, the two scripts that need a Postgres superuser. It asks
# for the superuser's name and password and sets libpq's variables for psql (but for
# `pi-migrate --auto`, below). The server is the
# one the admin URL names, as the entrypoint wrote it to a file only root reads or writes, and
# never as pi's admin.env has it: pi cannot write /run/pi, but it owns admin.env and can rewrite
# what the file holds, so it could name a server of its own there to be sent the password. The password is read with no echo and held in this process's
# environment only: it is never an argument, and never stored.
hostport=$(cat /run/pi-root/admin-host 2> /dev/null || :)
[ -n "$hostport" ] || { echo 'set PI_DATABASE_URL_ADMIN' >&2; exit 1; }
PGHOST=${hostport%%:*}
case $hostport in *:*) PGPORT=${hostport##*:} ;; *) PGPORT=5432 ;; esac
PGDATABASE=postgres
PGCONNECT_TIMEOUT=10
# The admin URL's sslmode and sslrootcert, from the same root-only directory. An sslmode must be
# require, verify-ca or verify-full: with a weaker one, or none, libpq may fall back to an
# unencrypted connection, where a server can ask for the password in the clear. The box's psql
# predates libpq's require_auth, so the TLS requirement is what keeps the password encrypted.
# With no sslmode, libpq's default stands as before. `dbquery` carries the two on to the
# bootstrap URL pi-migrate makes.
dbquery=
set -f
for pair in $(tr '&' ' ' 2> /dev/null < /run/pi-root/admin-query || :); do
  case $pair in sslmode=* | sslrootcert=*) ;; *) continue ;; esac
  case ${pair#*=} in '' | *[!A-Za-z0-9._/-]*) echo 'unsupported sslmode or sslrootcert in PI_DATABASE_URL_ADMIN' >&2; exit 1 ;; esac
  dbquery=${dbquery:+$dbquery&}$pair
  case $pair in
    sslmode=require | sslmode=verify-ca | sslmode=verify-full)
      PGSSLMODE=${pair#*=} PGREQUIREAUTH=scram-sha-256
      export PGSSLMODE PGREQUIREAUTH
      ;;
    sslmode=*) echo 'PI_DATABASE_URL_ADMIN sslmode must be require, verify-ca or verify-full' >&2; exit 1 ;;
    *) PGSSLROOTCERT=${pair#*=}; export PGSSLROOTCERT ;;
  esac
done
set +f
# `pi-migrate --auto` sets `standing` before it reads this: it connects to the same server as the
# box's migration role, with the password in root's own file, so nothing is asked here and no
# superuser is named.
if [ -z "${standing:-}" ]; then
  printf 'Postgres superuser name [postgres]: ' >&2
  IFS= read -r PGUSER
  [ -n "$PGUSER" ] || PGUSER=postgres
  printf 'Postgres superuser password: ' >&2
  # Echo comes back however the prompt ends, an interrupt included.
  if [ -t 0 ]; then trap 'stty echo; exit 1' HUP INT TERM; stty -echo; fi
  IFS= read -r PGPASSWORD
  if [ -t 0 ]; then stty echo; trap - HUP INT TERM; echo >&2; fi
  export PGUSER PGPASSWORD
fi
export PGHOST PGPORT PGDATABASE PGCONNECT_TIMEOUT
sql() { /usr/bin/psql -X -q -At -v ON_ERROR_STOP=1; }
