#!/bin/sh
# Validates ELPX_ISOLATION before nginx renders the configuration template.
case "${ELPX_ISOLATION:-off}" in
  on|off) ;;
  *) echo "ELPX_ISOLATION must be 'on' or 'off'" >&2; exit 1 ;;
esac
