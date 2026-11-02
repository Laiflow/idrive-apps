#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Nisipeanu
# shutdown_mark.sh — run by var-opt-ro.service (drop-in
# 50-waze-on-cluster.conf) at each head-unit shutdown, before /var/opt goes
# read-only. recmgr's reboot after a crash and a switch-off are both an NSM
# fast shutdown that stops no service, so carplay's state at that moment tells them apart
# for boot recovery (recovery.js): it writes "<boot id> running|failed|stopped"
# to <state dir>/shutdown. failed is a Result other than success. It writes
# nothing when carplay's state cannot be read within WAIT seconds, and always
# exits 0, so it never holds up the remount.
DIR=${WOC_STATE_DIR:-/var/opt/waze-on-cluster}
BOOT_ID=${WOC_BOOT_ID:-/proc/sys/kernel/random/boot_id}
SYSTEMCTL=${WOC_SYSTEMCTL:-systemctl}
WAIT=${WOC_MARK_WAIT:-3}

[ -d "$DIR" ] || exit 0
boot=$(cat "$BOOT_ID" 2>/dev/null) || exit 0
# The unit has no timeout(1) on its path: systemctl runs in the background and
# is killed after WAIT seconds.
out="$DIR/shutdown.show"
"$SYSTEMCTL" show carplay.service -p ActiveState -p Result > "$out" 2>/dev/null &
pid=$!
( sleep "$WAIT"; kill "$pid" 2>/dev/null ) &
guard=$!
wait "$pid"
status=$?
kill "$guard" 2>/dev/null
[ "$status" -eq 0 ] || { rm -f "$out"; exit 0; }
show=$(cat "$out")
rm -f "$out"
case "$show" in
  *Result=success*)
    case "$show" in
      *ActiveState=active*|*ActiveState=activating*|*ActiveState=reloading*) state=running ;;
      *) state=stopped ;;
    esac ;;
  *Result=*) state=failed ;;
  *) exit 0 ;;
esac
printf '%s %s\n' "$boot" "$state" > "$DIR/shutdown.tmp" && mv -f "$DIR/shutdown.tmp" "$DIR/shutdown"
exit 0
