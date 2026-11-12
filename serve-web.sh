#!/bin/sh
set -eu
cd "$(dirname "$0")/web"
exec python3 -m http.server 8080 --bind 127.0.0.1
