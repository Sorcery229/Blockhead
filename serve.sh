#!/bin/bash
# Convenience wrapper — see serve.py for what it does differently from
# `python3 -m http.server` (compression on, caching off).
exec python3 "$(dirname "$0")/serve.py" "$@"
