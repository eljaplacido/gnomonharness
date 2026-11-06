/*
 * netguard: run a command, and everything it starts, with no route off this
 * machine. GBS apparatus for gbs-2026-11-05-ossandbox, where the governance
 * trials run on the host (not in a --network none container) and a probe must
 * not be able to reach anything.
 *
 *   netguard --port P [--port P]... -- <program> [args...]
 *
 * Two kernel mechanisms, both irrevocable and inherited by every descendant:
 *
 *  1. Landlock network rules (ABI >= 4): TCP connect is allowed ONLY to the
 *     listed ports (the scripted model, the canary, the benign dev server).
 *     A connect to any other port, on any address, gets EACCES before a
 *     packet is built. DNS over TCP (53) is therefore impossible too.
 *  2. A seccomp filter WITHOUT a notification listener (so gnomon-exec, which
 *     installs its own listener for exec = "os", still can: the kernel allows
 *     one listener per filter chain): sockets other than AF_UNIX, AF_NETLINK
 *     and TCP over AF_INET/AF_INET6 get EACCES (no UDP, so no DNS query
 *     leaves; no raw, packet, ICMP, SCTP or vsock); MSG_FASTOPEN gets EACCES
 *     (TCP Fast Open connects from sendto without the connect hook); io_uring
 *     gets ENOSYS (IORING_OP_SOCKET/CONNECT bypass seccomp); a foreign-arch
 *     syscall kills the process.
 *
 * What is left: a TCP connect to a listed port. The listed ports are
 * ephemeral ports bound by the apparatus on 127.0.0.1 and one local,
 * non-loopback interface address; a probe can name no other host, because
 * no name resolves (no UDP, no TCP 53) and the corpus names only {HOST}.
 * Refuses (exit 125) rather than run unguarded if either mechanism fails.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <netinet/in.h>
#include <unistd.h>

#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#define SYS_landlock_add_rule 445
#define SYS_landlock_restrict_self 446
#endif
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#define LANDLOCK_RULE_NET_PORT 2
#define LANDLOCK_ACCESS_NET_CONNECT_TCP (1ULL << 1)

struct ruleset_attr { uint64_t handled_access_fs; uint64_t handled_access_net; };
struct net_port_attr { uint64_t allowed_access; uint64_t port; } __attribute__((packed));

#if defined(__aarch64__)
#define ARCH AUDIT_ARCH_AARCH64
#elif defined(__x86_64__)
#define ARCH AUDIT_ARCH_X86_64
#else
#error "netguard: x86_64 or aarch64 only"
#endif

static void die(const char *what) {
    fprintf(stderr, "netguard: refused: %s: %s\n", what, strerror(errno));
    exit(125);
}

#define LD(off) BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (off))
#define JEQ(k, t, f) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (k), (t), (f))
#define RET(k) BPF_STMT(BPF_RET | BPF_K, (k))
#define ARG(n) (offsetof(struct seccomp_data, args) + 8 * (n))

int main(int argc, char **argv) {
    uint64_t ports[64];
    int nports = 0, i = 1;
    for (; i < argc; i++) {
        if (strcmp(argv[i], "--") == 0) { i++; break; }
        if (strcmp(argv[i], "--port") == 0 && i + 1 < argc && nports < 64) {
            long p = strtol(argv[++i], NULL, 10);
            if (p <= 0 || p > 65535) { fprintf(stderr, "netguard: refused: bad port %s\n", argv[i]); return 125; }
            ports[nports++] = (uint64_t)p;
            continue;
        }
        fprintf(stderr, "netguard: refused: usage: netguard --port P... -- cmd...\n");
        return 125;
    }
    if (i >= argc) { fprintf(stderr, "netguard: refused: no command\n"); return 125; }

    long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 4) { errno = abi < 0 ? errno : ENOTSUP; die("Landlock ABI >= 4 (network rules) is required"); }
    struct ruleset_attr ra = { .handled_access_fs = 0, .handled_access_net = LANDLOCK_ACCESS_NET_CONNECT_TCP };
    int rs = (int)syscall(SYS_landlock_create_ruleset, &ra, sizeof ra, 0);
    if (rs < 0) die("landlock_create_ruleset");
    for (int k = 0; k < nports; k++) {
        struct net_port_attr pa = { .allowed_access = LANDLOCK_ACCESS_NET_CONNECT_TCP, .port = ports[k] };
        if (syscall(SYS_landlock_add_rule, rs, LANDLOCK_RULE_NET_PORT, &pa, 0) < 0) die("landlock_add_rule");
    }
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) die("PR_SET_NO_NEW_PRIVS");
    if (syscall(SYS_landlock_restrict_self, rs, 0) < 0) die("landlock_restrict_self");
    close(rs);

    struct sock_filter f[] = {
        LD(offsetof(struct seccomp_data, arch)),
        JEQ(ARCH, 1, 0),
        RET(SECCOMP_RET_KILL_PROCESS),
        LD(offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
        RET(SECCOMP_RET_ERRNO | ENOSYS),
#endif
        /* Offsets are relative (target - index - 1); indices from the LD(nr) above.
         * The layout is checked by `netguard --self-test`, which exercises every path. */
        JEQ(SYS_socket, 6, 0),             /* -> socket */
        JEQ(SYS_sendto, 16, 0),            /* -> flags3 */
        JEQ(SYS_sendmmsg, 15, 0),          /* -> flags3 */
        JEQ(SYS_sendmsg, 16, 0),           /* -> flags2 */
        JEQ(SYS_io_uring_setup, 19, 0),    /* -> enosys */
        JEQ(SYS_io_uring_enter, 18, 0),    /* -> enosys */
        JEQ(SYS_io_uring_register, 17, 15),/* -> enosys : allow */
        /* socket: */
        LD(ARG(0)),
        JEQ(AF_UNIX, 13, 0),               /* -> allow */
        JEQ(AF_NETLINK, 12, 0),            /* -> allow */
        JEQ(AF_INET, 1, 0),                /* -> inet */
        JEQ(AF_INET6, 0, 11),              /* inet : eacces */
        /* inet: */
        LD(ARG(1)),
        BPF_STMT(BPF_ALU | BPF_AND | BPF_K, ~(uint32_t)(SOCK_NONBLOCK | SOCK_CLOEXEC)),
        JEQ(SOCK_STREAM, 0, 8),            /* : eacces */
        LD(ARG(2)),
        JEQ(0, 5, 0),                      /* -> allow */
        JEQ(IPPROTO_TCP, 4, 5),            /* -> allow : eacces */
        /* flags3: sendto, sendmmsg */
        LD(ARG(3)),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, MSG_FASTOPEN, 3, 2), /* -> eacces : allow */
        /* flags2: sendmsg */
        LD(ARG(2)),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, MSG_FASTOPEN, 1, 0), /* -> eacces : allow */
        RET(SECCOMP_RET_ALLOW),            /* allow */
        RET(SECCOMP_RET_ERRNO | EACCES),   /* eacces */
        RET(SECCOMP_RET_ERRNO | ENOSYS),   /* enosys */
    };
    struct sock_fprog prog = { .len = sizeof f / sizeof f[0], .filter = f };
    if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog) != 0) die("seccomp");

    execvp(argv[i], argv + i);
    fprintf(stderr, "netguard: %s: %s\n", argv[i], strerror(errno));
    return 127;
}
