#!/usr/bin/env bash
# peppermint's server-side preparation, run as root by the template's install.sh before the build is swapped in.
set -euo pipefail
# libvips makes the smaller picture copies; without it the originals are served
command -v vipsthumbnail >/dev/null || apt-get install -y -qq --no-install-recommends libvips-tools >/dev/null
# Inter draws the text in the email header and charts (rendered to PNG here); without it they fall back to DejaVu
dpkg -s fonts-inter >/dev/null 2>&1 || apt-get install -y -qq --no-install-recommends fonts-inter >/dev/null
