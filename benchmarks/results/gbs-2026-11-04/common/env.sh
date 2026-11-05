# Source this from a GBS runner. It points the runner at the pinned gnomon
# v0.4.1 install and refuses to continue on any other build.
#
#   GBS_SCRATCH=<dir holding prefix/ and home/ from INSTALL.md> . common/env.sh
#
# The install itself is described in INSTALL.md. Nothing here reaches a
# network: the update check is switched off, and every endpoint a runner uses
# is a fake model server on an ephemeral loopback port.
: "${GBS_SCRATCH:?set GBS_SCRATCH to the directory INSTALL.md installed into}"
export GBS_PREFIX="$GBS_SCRATCH/prefix"
export GNOMON_BIN_OVERRIDE="$GBS_SCRATCH/home/.local/share/gnomon/bin"
export PATH="$GBS_PREFIX/bin:$PATH"
export GNOMON_NO_UPDATE_CHECK=1
export GBS_EXPECT_VERSION="gnomon/0.4.1+v0.4.1-c511b81"
gbs_check_build() {
    v=$(gnomon --version 2>/dev/null)
    if [ "$v" != "$GBS_EXPECT_VERSION" ]; then
        echo "GBS: wrong build under test: '$v' (expected $GBS_EXPECT_VERSION)" >&2
        return 1
    fi
}
