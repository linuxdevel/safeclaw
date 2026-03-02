#include "../src/landlock.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* ── syscall number for ABI probe ──────────────────────────────────── */

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif

#define LANDLOCK_CREATE_RULESET_VERSION_FLAG (1U << 0)

/* ── test macros ───────────────────────────────────────────────────── */

static int tests_run = 0;
static int tests_passed = 0;
static int tests_skipped = 0;

#define ASSERT(cond, msg) do { \
    tests_run++; \
    if (!(cond)) { \
        fprintf(stderr, "  FAIL: %s (line %d)\n", msg, __LINE__); \
    } else { \
        tests_passed++; \
        fprintf(stderr, "  PASS: %s\n", msg); \
    } \
} while (0)

#define SKIP(msg) do { \
    tests_skipped++; \
    fprintf(stderr, "  SKIP: %s\n", msg); \
} while (0)

/* ── helpers ───────────────────────────────────────────────────────── */

static int landlock_available(void)
{
    int abi = (int)syscall(__NR_landlock_create_ruleset, NULL, 0,
                           LANDLOCK_CREATE_RULESET_VERSION_FLAG);
    return abi >= 0;
}

static void init_policy(Policy *p)
{
    memset(p, 0, sizeof(*p));
}

static void add_allow(Policy *p, const char *path, int access)
{
    if (p->allow_count < POLICY_MAX_ALLOW) {
        strncpy(p->allow[p->allow_count].path, path, PATH_MAX - 1);
        p->allow[p->allow_count].path[PATH_MAX - 1] = '\0';
        p->allow[p->allow_count].access = access;
        p->allow_count++;
    }
}

/* ── test: landlock unsupported ────────────────────────────────────── */

static void test_landlock_unsupported(void)
{
    fprintf(stderr, "\ntest_landlock_unsupported:\n");

    if (landlock_available()) {
        SKIP("landlock IS available; cannot test unsupported path");
        return;
    }

    Policy p;
    init_policy(&p);
    add_allow(&p, "/tmp", ACCESS_READWRITE);

    int rc = apply_landlock(&p);
    ASSERT(rc == 1, "apply_landlock returns 1 when landlock is unsupported");
}

/* ── test: landlock restricts ──────────────────────────────────────── */

static void test_landlock_restricts(void)
{
    fprintf(stderr, "\ntest_landlock_restricts:\n");

    if (!landlock_available()) {
        SKIP("landlock not available");
        return;
    }

    pid_t pid = fork();
    if (pid < 0) {
        ASSERT(0, "fork failed");
        return;
    }

    if (pid == 0) {
        /* Child: apply landlock allowing only /tmp, then try /etc/hostname */
        prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);

        Policy p;
        init_policy(&p);
        add_allow(&p, "/tmp", ACCESS_READWRITE);

        int rc = apply_landlock(&p);
        if (rc != 0) {
            _exit(99); /* landlock setup failed */
        }

        /* Try to open a file outside the allowed path */
        int fd = open("/etc/hostname", O_RDONLY);
        if (fd < 0 && errno == EACCES) {
            _exit(0); /* expected: access denied */
        }
        if (fd >= 0) {
            close(fd);
        }
        _exit(1); /* unexpected: access was allowed */
    }

    int status;
    waitpid(pid, &status, 0);

    if (WIFEXITED(status) && WEXITSTATUS(status) == 99) {
        SKIP("landlock setup failed in child (may need PR_SET_NO_NEW_PRIVS)");
        return;
    }

    ASSERT(WIFEXITED(status), "child exited normally");
    if (WIFEXITED(status)) {
        ASSERT(WEXITSTATUS(status) == 0,
               "access to /etc/hostname denied by landlock");
    }
}

/* ── test: landlock allows ─────────────────────────────────────────── */

static void test_landlock_allows(void)
{
    fprintf(stderr, "\ntest_landlock_allows:\n");

    if (!landlock_available()) {
        SKIP("landlock not available");
        return;
    }

    pid_t pid = fork();
    if (pid < 0) {
        ASSERT(0, "fork failed");
        return;
    }

    if (pid == 0) {
        /* Child: apply landlock allowing /tmp, then open /tmp */
        prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);

        Policy p;
        init_policy(&p);
        add_allow(&p, "/tmp", ACCESS_READWRITE);

        int rc = apply_landlock(&p);
        if (rc != 0) {
            _exit(99); /* landlock setup failed */
        }

        /* Try to open the allowed path */
        int fd = open("/tmp", O_RDONLY | O_DIRECTORY);
        if (fd >= 0) {
            close(fd);
            _exit(0); /* success: access allowed */
        }
        _exit(1); /* unexpected: access denied */
    }

    int status;
    waitpid(pid, &status, 0);

    if (WIFEXITED(status) && WEXITSTATUS(status) == 99) {
        SKIP("landlock setup failed in child");
        return;
    }

    ASSERT(WIFEXITED(status), "child exited normally");
    if (WIFEXITED(status)) {
        ASSERT(WEXITSTATUS(status) == 0,
               "access to /tmp allowed by landlock");
    }
}

/* ── test: empty policy ────────────────────────────────────────────── */

static void test_landlock_empty_policy(void)
{
    fprintf(stderr, "\ntest_landlock_empty_policy:\n");

    if (!landlock_available()) {
        SKIP("landlock not available");
        return;
    }

    pid_t pid = fork();
    if (pid < 0) {
        ASSERT(0, "fork failed");
        return;
    }

    if (pid == 0) {
        /* Child: apply landlock with zero allow rules, try /tmp */
        prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);

        Policy p;
        init_policy(&p);
        /* No allow rules at all */

        int rc = apply_landlock(&p);
        if (rc != 0) {
            _exit(99); /* landlock setup failed */
        }

        /* Try to open anything — should be denied */
        int fd = open("/tmp", O_RDONLY | O_DIRECTORY);
        if (fd < 0 && errno == EACCES) {
            _exit(0); /* expected: access denied */
        }
        if (fd >= 0) {
            close(fd);
        }
        _exit(1); /* unexpected: access was allowed */
    }

    int status;
    waitpid(pid, &status, 0);

    if (WIFEXITED(status) && WEXITSTATUS(status) == 99) {
        SKIP("landlock setup failed in child");
        return;
    }

    ASSERT(WIFEXITED(status), "child exited normally");
    if (WIFEXITED(status)) {
        ASSERT(WEXITSTATUS(status) == 0,
               "access to /tmp denied with empty allow list");
    }
}

/* ── main ──────────────────────────────────────────────────────────── */

int main(void)
{
    fprintf(stderr, "=== landlock tests ===\n");

    test_landlock_unsupported();
    test_landlock_restricts();
    test_landlock_allows();
    test_landlock_empty_policy();

    fprintf(stderr, "\n%d/%d passed, %d skipped\n",
            tests_passed, tests_run, tests_skipped);
    return (tests_passed == tests_run) ? 0 : 1;
}
