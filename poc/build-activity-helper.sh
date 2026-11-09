#!/bin/sh
# No downloads/installs. Generated protocol files and binary stay in this tree.
set -eu
cd "$(dirname "$0")"
mkdir -p .activity-build
protocol="$(pkg-config --variable=pkgdatadir wayland-protocols)/staging/ext-idle-notify/ext-idle-notify-v1.xml"
wayland-scanner client-header "$protocol" .activity-build/activity-idle-protocol.h
wayland-scanner private-code "$protocol" .activity-build/activity-idle-protocol.c
${CC:-cc} -std=c11 -Wall -Wextra -Werror -O2 -I.activity-build \
  $(pkg-config --cflags wayland-client) activity-idle.c .activity-build/activity-idle-protocol.c \
  $(pkg-config --libs wayland-client) -o .activity-build/activity-idle
printf '%s\n' 'Built poc/.activity-build/activity-idle (local generated artifact; do not commit)'
