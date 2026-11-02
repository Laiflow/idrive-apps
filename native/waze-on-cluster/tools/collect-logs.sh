#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Nisipeanu
# collect-logs.sh — gather what a report of the map on the cluster needs into
# one archive, to send back. Run it on the head unit as root:
#
#   sh /var/opt/waze-on-cluster/current/collect-logs.sh
#
# It writes /tmp/woc-logs-<UTC date and time>.tar.gz and prints its path:
# both tools' log files (with their .1), the renderer's and the capture's
# status files, this boot's journal of the tools and of carplay (what the
# journal still holds), the list of boots, the carplay patch probe (where its
# edit sites are in this carplay), the tools' folders, their local settings,
# the time and the uptime. Anything missing is left out. It changes
# nothing on the unit. POSIX sh, for the unit's shell.
set -u
umask 077

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NAME=woc-logs-$STAMP
OUT=/tmp/$NAME.tar.gz
STAGE=$(mktemp -d /tmp/woc-logs.XXXXXX) || { echo "collect-logs: cannot make a folder in /tmp" >&2; exit 1; }
trap 'rm -rf "$STAGE"' EXIT
trap 'exit 1' INT TERM
DIR=$STAGE/$NAME
mkdir -p "$DIR"

# copy SRC DEST_NAME: a regular file (never a link), silently skipped otherwise
copy() {
    if [ -f "$1" ] && [ ! -L "$1" ]; then
        cat "$1" > "$DIR/$2" 2>/dev/null || rm -f "$DIR/$2"
    fi
}

for tool in cluster-render waze-on-cluster; do
    for f in "$tool.log" "$tool.log.1"; do
        copy "/var/opt/$tool/log/$f" "$f"
    done
    copy "/var/opt/$tool/$tool.local.conf" "$tool.local.conf"
done
copy /var/opt/waze-on-cluster/boot-recovery.json boot-recovery.json
copy /var/opt/waze-on-cluster/shutdown boot-recovery-shutdown

for f in /run/cluster-render/*; do
    copy "$f" "run-cluster-render-${f##*/}"
done
for f in status.json probe.txt; do
    copy "/run/waze-on-cluster/$f" "run-waze-on-cluster-$f"
done

if command -v journalctl >/dev/null 2>&1; then
    for unit in cluster-render waze-on-cluster waze-on-cluster-patchd waze-on-cluster-boot waze-on-cluster-recovery carplay; do
        journalctl -b -o short-precise --no-pager -u "$unit" > "$DIR/journal-$unit.txt" 2>/dev/null
    done
    journalctl --list-boots --no-pager > "$DIR/boots.txt" 2>/dev/null
fi

HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
if [ -f "$HERE/carplay_patch.js" ]; then
    NODE=$(command -v node || echo /usr/bin/node)
    "$NODE" "$HERE/carplay_patch.js" probe > "$DIR/carplay-probe.txt" 2>&1
fi

ls -l /var/opt/cluster-render /var/opt/waze-on-cluster > "$DIR/ls.txt" 2>&1

{
    echo "date: $(date 2>/dev/null)"
    echo "utc: $(date -u 2>/dev/null)"
    echo "uptime: $(uptime 2>/dev/null)"
} > "$DIR/time.txt"

if ! tar -cf "$STAGE/$NAME.tar" -C "$STAGE" "$NAME" 2>/dev/null || ! gzip -c "$STAGE/$NAME.tar" > "$OUT"; then
    rm -f "$OUT"
    echo "collect-logs: could not write $OUT" >&2
    exit 1
fi
echo "$OUT"
