#!/bin/sh
echo "$*" >> "$GITCOUNT_LOG"
exec /usr/bin/git "$@"
