#include "seccomp.h"
#include "syscall_table.h"

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>

/* ── Kernel ABI definitions ──────────────────────────────────────────
   musl does not ship linux/filter.h, linux/seccomp.h, or linux/audit.h
   so we define the required structures and constants inline.
   These are stable kernel ABI and will not change.
   ──────────────────────────────────────────────────────────────────── */

#ifndef AUDIT_ARCH_X86_64
#define AUDIT_ARCH_X86_64 0xC000003EU
#endif

#ifndef SECCOMP_RET_KILL_PROCESS
#define SECCOMP_RET_KILL_PROCESS 0x80000000U
#endif

#ifndef SECCOMP_RET_ALLOW
#define SECCOMP_RET_ALLOW 0x7FFF0000U
#endif

#ifndef SECCOMP_SET_MODE_FILTER
#define SECCOMP_SET_MODE_FILTER 1
#endif

/* BPF instruction (struct sock_filter) — stable kernel ABI */
struct sock_filter {
    uint16_t code;
    uint8_t  jt;
    uint8_t  jf;
    uint32_t k;
};

/* BPF program descriptor (struct sock_fprog) */
struct sock_fprog {
    unsigned short len;
    struct sock_filter *filter;
};

/* seccomp_data — the structure the BPF program operates on */
struct seccomp_data {
    int   nr;
    uint32_t arch;
    uint64_t instruction_pointer;
    uint64_t args[6];
};

/* BPF instruction classes and modes */
#define BPF_LD   0x00
#define BPF_JMP  0x05
#define BPF_RET  0x06
#define BPF_W    0x00
#define BPF_ABS  0x20
#define BPF_JEQ  0x10
#define BPF_K    0x00

#define BPF_STMT(code, k) \
    { (uint16_t)(code), 0, 0, (uint32_t)(k) }

#define BPF_JUMP(code, k, jt, jf) \
    { (uint16_t)(code), (uint8_t)(jt), (uint8_t)(jf), (uint32_t)(k) }

/* ── Implementation ─────────────────────────────────────────────────── */

/* Max BPF instructions: 4 header + POLICY_MAX_SYSCALLS checks + 2 ret = 262 */
#define MAX_BPF_INSNS (POLICY_MAX_SYSCALLS + 6)

int install_seccomp_filter(const Policy *policy)
{
    struct sock_filter insns[MAX_BPF_INSNS];
    int count = policy->syscall_count;
    int nr_table[POLICY_MAX_SYSCALLS];

    /* Phase 1: resolve all syscall names to numbers.
       If any name is unknown, abort before installing anything. */
    for (int i = 0; i < count; i++) {
        int nr = syscall_lookup(policy->syscalls[i]);
        if (nr < 0) {
            fprintf(stderr,
                    "safeclaw-sandbox-helper: error: unknown syscall '%s'\n",
                    policy->syscalls[i]);
            return -1;
        }
        nr_table[i] = nr;
    }

    /*
     * BPF program layout:
     *
     *   [0]           BPF_LD   — load arch from seccomp_data.arch
     *   [1]           BPF_JEQ  — if arch == AUDIT_ARCH_X86_64, skip to [3]
     *   [2]           BPF_RET  — SECCOMP_RET_KILL_PROCESS (wrong arch)
     *   [3]           BPF_LD   — load syscall nr from seccomp_data.nr
     *   [4..4+N-1]   BPF_JEQ  — check each allowed syscall → jump to ALLOW
     *   [4+N]        BPF_RET  — SECCOMP_RET_KILL_PROCESS (default deny)
     *   [4+N+1]      BPF_RET  — SECCOMP_RET_ALLOW
     *
     * For each JEQ at index [4+i] (where i = 0..N-1):
     *   ALLOW is at index [4+N+1]
     *   jt = (4+N+1) - (4+i) - 1 = N - i
     *   jf = 0 (fall through to next instruction)
     */

    int idx = 0;

    /* [0] Load architecture from seccomp_data.arch */
    insns[idx++] = (struct sock_filter)BPF_STMT(
        BPF_LD | BPF_W | BPF_ABS,
        (uint32_t)offsetof(struct seccomp_data, arch));

    /* [1] Check arch == AUDIT_ARCH_X86_64; if match skip 1 (to [3]), else fall through */
    insns[idx++] = (struct sock_filter)BPF_JUMP(
        BPF_JMP | BPF_JEQ | BPF_K,
        AUDIT_ARCH_X86_64,
        1, 0);

    /* [2] Wrong architecture: kill process */
    insns[idx++] = (struct sock_filter)BPF_STMT(
        BPF_RET | BPF_K,
        SECCOMP_RET_KILL_PROCESS);

    /* [3] Load syscall number from seccomp_data.nr */
    insns[idx++] = (struct sock_filter)BPF_STMT(
        BPF_LD | BPF_W | BPF_ABS,
        (uint32_t)offsetof(struct seccomp_data, nr));

    /* [4..4+N-1] Check each allowed syscall */
    for (int i = 0; i < count; i++) {
        /* jt = N - i  (distance from this insn to the ALLOW ret) */
        unsigned char jt = (unsigned char)(count - i);
        insns[idx++] = (struct sock_filter)BPF_JUMP(
            BPF_JMP | BPF_JEQ | BPF_K,
            (uint32_t)nr_table[i],
            jt, 0);
    }

    /* [4+N] Default deny: kill process */
    insns[idx++] = (struct sock_filter)BPF_STMT(
        BPF_RET | BPF_K,
        SECCOMP_RET_KILL_PROCESS);

    /* [4+N+1] Allow */
    insns[idx++] = (struct sock_filter)BPF_STMT(
        BPF_RET | BPF_K,
        SECCOMP_RET_ALLOW);

    struct sock_fprog prog = {
        .len = (unsigned short)idx,
        .filter = insns,
    };

    /* Install the filter.
       Assumes PR_SET_NO_NEW_PRIVS is already set by the caller. */
    if (syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog) < 0) {
        fprintf(stderr,
                "safeclaw-sandbox-helper: error: seccomp(SET_MODE_FILTER) failed\n");
        return -1;
    }

    return 0;
}
