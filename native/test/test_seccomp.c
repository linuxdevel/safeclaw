#include "../src/seccomp.h"
#include "../src/syscall_table.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/prctl.h>
#include <unistd.h>
#include <signal.h>

static int tests_run = 0;
static int tests_passed = 0;

#define ASSERT(cond, msg) do { \
    tests_run++; \
    if (!(cond)) { \
        fprintf(stderr, "  FAIL: %s (line %d)\n", msg, __LINE__); \
    } else { \
        tests_passed++; \
        fprintf(stderr, "  PASS: %s\n", msg); \
    } \
} while (0)

/* ── helpers ─────────────────────────────────────────────────────────── */

static void add_syscall(Policy *p, const char *name)
{
    if (p->syscall_count < POLICY_MAX_SYSCALLS) {
        strncpy(p->syscalls[p->syscall_count], name, POLICY_SYSCALL_NAMELEN - 1);
        p->syscalls[p->syscall_count][POLICY_SYSCALL_NAMELEN - 1] = '\0';
        p->syscall_count++;
    }
}

static void init_policy(Policy *p)
{
    memset(p, 0, sizeof(*p));
    /* default_deny is ignored by install_seccomp_filter (always denylist mode).
       default_allow = 0 matches the memset. */
}

/* ── test: default-allow (non-denied syscalls work) ─────────────────── */

static void test_allowed_syscalls(void)
{
    fprintf(stderr, "\ntest_allowed_syscalls:\n");

    pid_t pid = fork();
    if (pid < 0) {
        ASSERT(0, "fork failed");
        return;
    }

    if (pid == 0) {
        /* Child: install denylist filter with only dangerous syscalls.
           write() is NOT in the deny list → default ALLOW should let it through. */
        Policy p;
        init_policy(&p);

        /* Deny kernel-takeover syscalls; leave write/exit/etc. allowed */
        add_syscall(&p, "ptrace");
        add_syscall(&p, "bpf");
        add_syscall(&p, "kexec_load");
        add_syscall(&p, "init_module");

        if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
            _exit(99);
        }

        if (install_seccomp_filter(&p) != 0) {
            _exit(98);
        }

        /* write() is not in deny list → should be allowed by default */
        const char msg[] = "seccomp: child alive\n";
        ssize_t wr = write(STDERR_FILENO, msg, sizeof(msg) - 1);
        if (wr < 0) _exit(97);

        _exit(0);
    }

    /* Parent: wait for child and check exit status */
    int status;
    waitpid(pid, &status, 0);

    ASSERT(WIFEXITED(status), "child exited normally");
    if (WIFEXITED(status)) {
        ASSERT(WEXITSTATUS(status) == 0,
               "child exit code is 0 (non-denied syscalls allowed by default)");
    }
}

/* ── test: denied syscalls ───────────────────────────────────────────── */

static void test_denied_syscalls(void)
{
    fprintf(stderr, "\ntest_denied_syscalls:\n");

    pid_t pid = fork();
    if (pid < 0) {
        ASSERT(0, "fork failed");
        return;
    }

    if (pid == 0) {
        /* Child: add getpid to the denylist, then call it.
           With denylist mode (default ALLOW), getpid must be explicitly
           denied to trigger SECCOMP_RET_KILL_PROCESS. */
        Policy p;
        init_policy(&p);

        add_syscall(&p, "getpid");

        if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
            _exit(99);
        }

        if (install_seccomp_filter(&p) != 0) {
            _exit(98);
        }

        /* getpid is in the denylist → SECCOMP_RET_KILL_PROCESS → SIGSYS */
        (void)getpid();

        /* Should never reach here */
        _exit(0);
    }

    /* Parent: wait for child and check it was killed */
    int status;
    waitpid(pid, &status, 0);

    ASSERT(WIFSIGNALED(status), "child was killed by signal");
    if (WIFSIGNALED(status)) {
        ASSERT(WTERMSIG(status) == SIGSYS,
               "child was killed by SIGSYS (denied syscall)");
    }
}

/* ── test: unknown syscall name ──────────────────────────────────────── */

static void test_unknown_syscall(void)
{
    fprintf(stderr, "\ntest_unknown_syscall:\n");

    Policy p;
    init_policy(&p);

    add_syscall(&p, "read");
    add_syscall(&p, "nonexistent_syscall");
    add_syscall(&p, "write");

    int rc = install_seccomp_filter(&p);
    ASSERT(rc == -1, "install_seccomp_filter returns -1 for unknown syscall");
}

/* ── main ────────────────────────────────────────────────────────────── */

int main(void)
{
    fprintf(stderr, "=== seccomp filter tests ===\n");

    test_allowed_syscalls();
    test_denied_syscalls();
    test_unknown_syscall();

    fprintf(stderr, "\n%d/%d tests passed\n", tests_passed, tests_run);
    return (tests_passed == tests_run) ? 0 : 1;
}
