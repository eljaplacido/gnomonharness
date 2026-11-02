#!/usr/bin/env bash
# gnomon v0.3.1 webfetch gating, model-free: the network scenario's role, with the
# tool as shipped (disabled in tools.toml) and enabled, under network = false / true.
# usage: webfetch_gating.sh <image> [<probes dir to mount over the image's copy>]
set -u
IMG=$1; MNT=${2:+-v $2:/opt/g2b/apparatus/probes:ro}
for WF in 0 1; do for NET in false true; do
  echo "# webfetch enabled in tools.toml: $WF; [sandbox] network = $NET"
  docker run --rm --name g2b-probe-wf --network none $MNT -e G2B_WEBFETCH=$WF -e G2B_NETWORK=$NET "$IMG" \
    python3 -I /opt/g2b/apparatus/probes/probe.py gnomon network-disabled-fetch webfetch '{"url":"http://127.0.0.1:18099/changelog.txt"}' 2>/dev/null | tail -1
done; done
