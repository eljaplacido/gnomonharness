## When a command hits the bash timeout

The bash tool returns after 120 seconds. A command still running at that point
was **cut off** — it did not fail, and it did not finish. Re-issuing it verbatim
will cut off at the same place, every time.

**A retry after a timeout must change something.** Re-running the identical long
command is the one option that cannot work.

Two things that change something:

**Detach and poll.** Start it in the background and read its log on later turns:

    setsid <cmd> </dev/null >/tmp/job.log 2>&1 &

then on the next turn `tail /tmp/job.log`, check `pgrep -f <cmd>`, and continue
with other work while it runs. Use this for servers that must stay up, long
builds, and any single command you expect to exceed the limit.

**Resume from the tool's own checkpoint.** Long-running tools keep state so they
can continue where they stopped:

    john --session=NAME   # resumes; john --restore=NAME
    wget -c               # continues a partial download
    rsync --partial       # keeps what transferred
    make                  # skips what is already built

**Never delete a checkpoint and restart the same long command.** Removing a
session file and re-launching the identical job throws away the progress that
would have finished it, and guarantees the next attempt times out too.

If a command has timed out twice, stop repeating it and change approach: detach
it, resume it, narrow it (a smaller range, a subset of inputs), or solve the
task a different way.
