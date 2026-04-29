#!/bin/bash

# Dev environment manager using tmux
# Usage: ./dev/dev-env.sh [start|stop|status|attach|restart|psql|import-prod]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.dev.yml"
SESSION_NAME="lw-dev"
DB_URL="postgresql://postgres:postgres@localhost:5432/longterm_wiki"

start_dev() {
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        echo "Session '$SESSION_NAME' already running"
        exit 0
    fi

    cd "$REPO_ROOT"

    # Window 0 "db": Postgres in foreground
    tmux new-session -d -s "$SESSION_NAME" -n "db" -c "$REPO_ROOT"
    tmux send-keys -t "$SESSION_NAME:db" "docker compose -f $COMPOSE_FILE up" Enter

    # Wait for Postgres to be ready
    echo "Waiting for Postgres..."
    for i in $(seq 1 30); do
        if docker compose -f "$COMPOSE_FILE" exec -T db pg_isready -U postgres >/dev/null 2>&1; then
            echo "Postgres ready"
            break
        fi
        if [ "$i" -eq 30 ]; then
            echo "Postgres failed to start"
            exit 1
        fi
        sleep 1
    done

    # Window 1 "wiki-server": wiki-server API
    tmux new-window -t "$SESSION_NAME" -n "wiki-server" -c "$REPO_ROOT/apps/wiki-server"
    tmux send-keys -t "$SESSION_NAME:wiki-server" "DATABASE_URL='$DB_URL' pnpm dev" Enter

    # Window 2 "web": Next.js frontend
    tmux new-window -t "$SESSION_NAME" -n "web" -c "$REPO_ROOT"
    tmux send-keys -t "$SESSION_NAME:web" "pnpm dev" Enter

    # Window 3 "work": shell for running crux commands
    tmux new-window -t "$SESSION_NAME" -n "work" -c "$REPO_ROOT"

    # Start on the work window
    tmux select-window -t "$SESSION_NAME:work"

    echo ""
    echo "Dev session '$SESSION_NAME' started with:"
    echo "  - db:          Postgres on :5432"
    echo "  - wiki-server: API on :3100"
    echo "  - web:         Next.js on :3001"
    echo "  - work:        Shell for crux commands"
    echo ""
    echo "Use './dev/dev-env.sh attach' or 'tmux attach -t $SESSION_NAME' to attach"
}

stop_dev() {
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        echo "Stopping dev environment..."
        tmux kill-session -t "$SESSION_NAME"
        echo "Session '$SESSION_NAME' stopped."
    else
        echo "Session '$SESSION_NAME' is not running."
    fi
    docker compose -f "$COMPOSE_FILE" stop 2>/dev/null
}

status_dev() {
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        echo "Session '$SESSION_NAME' is running."
        tmux list-windows -t "$SESSION_NAME"
    else
        echo "Session '$SESSION_NAME' is not running."
    fi
}

attach_dev() {
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        tmux attach -t "$SESSION_NAME"
    else
        echo "Session '$SESSION_NAME' is not running. Use 'start' first."
    fi
}

restart_dev() {
    if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        echo "Session '$SESSION_NAME' is not running. Starting fresh..."
        start_dev
        return
    fi

    echo "Restarting wiki-server and web (keeping Postgres)..."

    tmux send-keys -t "$SESSION_NAME:wiki-server" C-c
    sleep 1
    tmux send-keys -t "$SESSION_NAME:wiki-server" "DATABASE_URL='$DB_URL' pnpm dev" Enter

    tmux send-keys -t "$SESSION_NAME:web" C-c
    sleep 1
    tmux send-keys -t "$SESSION_NAME:web" "pnpm dev" Enter

    echo "Dev environment restarted."
}

psql_dev() {
    # Use -T to disable TTY so piped stdin works: cat file.sql | ./dev/dev-env.sh psql
    docker compose -f "$COMPOSE_FILE" exec -T db psql -U postgres -d longterm_wiki "$@"
}

psql_prod() {
    # Load PROD_DATABASE_URL from .env. Inject via env var (not argv) so the
    # connection string never appears in `ps` / `docker inspect`. Strip
    # surrounding quotes if the .env value is wrapped.
    local env_file="$REPO_ROOT/.env"
    if [ -f "$env_file" ]; then
        local prod_url
        prod_url=$(grep '^PROD_DATABASE_URL=' "$env_file" | cut -d= -f2-)
        prod_url=${prod_url#\"}; prod_url=${prod_url%\"}
        prod_url=${prod_url#\'}; prod_url=${prod_url%\'}
        if [ -n "$prod_url" ]; then
            docker run --network=host --rm -i \
                -e PGURL="$prod_url" \
                postgres:16 sh -c 'psql "$PGURL" "$@"' sh "$@"
            return
        fi
    fi
    echo "PROD_DATABASE_URL not found in .env"
    exit 1
}

import_prod() {
    echo "Importing prod database..."

    # Check for the latest backup artifact from GitHub Actions
    echo "Downloading latest backup from GitHub Actions..."
    ARTIFACT_DIR=$(mktemp -d)

    RUN_ID=$(gh run list --repo quantified-uncertainty/longterm-wiki \
        --workflow=database-backup.yml --status=success --limit=1 \
        --json databaseId -q '.[0].databaseId')

    if [ -z "$RUN_ID" ]; then
        echo "No backup run found. Make sure gh is authenticated and database-backup.yml has run."
        echo ""
        echo "Alternative: if you have direct DB access, run:"
        echo "  pg_dump \"\$PROD_DATABASE_URL\" | docker compose -f $COMPOSE_FILE exec -T db psql -U postgres -d longterm_wiki"
        rm -rf "$ARTIFACT_DIR"
        exit 1
    fi

    echo "Downloading artifact from run $RUN_ID..."
    gh run download "$RUN_ID" --repo quantified-uncertainty/longterm-wiki \
        --dir "$ARTIFACT_DIR" --pattern "longterm-wiki-*"

    DUMP_FILE=$(find "$ARTIFACT_DIR" -name "*.sql.gz" -type f | head -1)
    if [ -z "$DUMP_FILE" ]; then
        echo "No .sql.gz file found in artifact"
        rm -rf "$ARTIFACT_DIR"
        exit 1
    fi

    echo "Found: $DUMP_FILE"
    echo "Dropping and recreating database..."
    docker compose -f "$COMPOSE_FILE" exec -T db psql -U postgres -c "DROP DATABASE IF EXISTS longterm_wiki;"
    docker compose -f "$COMPOSE_FILE" exec -T db psql -U postgres -c "CREATE DATABASE longterm_wiki;"

    echo "Importing (this may take a few minutes)..."
    gunzip -c "$DUMP_FILE" | docker compose -f "$COMPOSE_FILE" exec -T db psql -U postgres -d longterm_wiki 2>&1 | tail -5

    rm -rf "$ARTIFACT_DIR"
    echo "Import complete."
}

case "${1:-start}" in
    start)
        start_dev
        ;;
    stop)
        stop_dev
        ;;
    status)
        status_dev
        ;;
    attach)
        attach_dev
        ;;
    restart)
        restart_dev
        ;;
    psql)
        shift
        psql_dev "$@"
        ;;
    psql-prod)
        shift
        psql_prod "$@"
        ;;
    import-prod)
        import_prod
        ;;
    *)
        echo "Usage: $0 [start|stop|status|attach|restart|psql|psql-prod|import-prod]"
        exit 1
        ;;
esac
