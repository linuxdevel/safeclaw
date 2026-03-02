#include "policy.h"
#include "landlock.h"
#include "seccomp.h"
#include "caps.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#define PREFIX "safeclaw-sandbox-helper: error: "

static void die(int code, const char *msg)
{
    fprintf(stderr, PREFIX "%s\n", msg);
    exit(code);
}

/*
 * parse_args — extract --policy-file and command after --
 *
 * Usage: safeclaw-sandbox-helper [--policy-file path] -- command [args...]
 *
 * Sets *policy_file to the path if --policy-file is given, NULL otherwise.
 * Sets *cmd_start to the index in argv of the command after --.
 * Returns 0 on success, -1 on error.
 */
static int parse_args(int argc, char *argv[],
                      const char **policy_file, int *cmd_start)
{
    *policy_file = NULL;
    *cmd_start = -1;

    int i = 1;

    /* Parse options before -- */
    while (i < argc) {
        if (strcmp(argv[i], "--") == 0) {
            i++;
            break;
        }
        if (strcmp(argv[i], "--policy-file") == 0) {
            if (i + 1 >= argc) {
                die(1, "--policy-file requires an argument");
            }
            *policy_file = argv[i + 1];
            i += 2;
            continue;
        }
        /* Unknown option or positional arg without -- */
        fprintf(stderr,
                "usage: safeclaw-sandbox-helper [--policy-file path] "
                "-- command [args...]\n");
        return -1;
    }

    if (i >= argc) {
        fprintf(stderr,
                "usage: safeclaw-sandbox-helper [--policy-file path] "
                "-- command [args...]\n");
        return -1;
    }

    *cmd_start = i;
    return 0;
}

int main(int argc, char *argv[])
{
    /* ── 1. Self-checks ─────────────────────────────────────────────── */

    /* Refuse to run if setuid/setgid */
    if (getuid() != geteuid() || getgid() != getegid()) {
        die(EXIT_ARCH_ERROR, "refusing to run as setuid/setgid");
    }

    /* ── 2. Parse arguments ─────────────────────────────────────────── */

    const char *policy_file = NULL;
    int cmd_start = -1;

    if (parse_args(argc, argv, &policy_file, &cmd_start) < 0) {
        return 1;
    }

    /* ── 3. Read and parse policy ───────────────────────────────────── */

    Policy policy;
    char errbuf[256];

    if (policy_file != NULL) {
        /* Read from file (includes mode 0600 and ownership checks) */
        if (policy_read_file(policy_file, &policy, errbuf,
                             (int)sizeof(errbuf)) < 0) {
            /* Distinguish permission errors from parse errors:
               policy_read_file returns -1 for both. Check errbuf. */
            if (strstr(errbuf, "mode must be 0600") != NULL ||
                strstr(errbuf, "not owned by") != NULL) {
                die(EXIT_PERM_ERROR, errbuf);
            }
            die(EXIT_POLICY_ERROR, errbuf);
        }
    } else {
        /* Read from fd 3 (default) */
        if (policy_read_fd(3, &policy, errbuf, (int)sizeof(errbuf)) < 0) {
            die(EXIT_POLICY_ERROR, errbuf);
        }
        /* Close fd 3 after reading */
        close(3);
    }

    /* ── 4. prctl(PR_SET_NO_NEW_PRIVS) — point of no return ────────── */

    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
        die(EXIT_PERM_ERROR, "prctl(PR_SET_NO_NEW_PRIVS) failed");
    }

    /* ── 5. Apply Landlock (filesystem restrictions) ────────────────── */

    int ll = apply_landlock(&policy);
    if (ll == 1) {
        fprintf(stderr,
                "safeclaw-sandbox-helper: warning: "
                "landlock not available, continuing without filesystem sandbox\n");
    } else if (ll < 0) {
        die(EXIT_LANDLOCK_ERROR, "landlock enforcement failed");
    }

    /* ── 6. Close all fds > 2 (fd hygiene) ──────────────────────────── */

    /* Done BEFORE seccomp so close_range doesn't need to be in the
       syscall allowlist. All Landlock path fds are already closed by
       apply_landlock(); fd 3 (policy) was closed after reading. */
#ifndef __NR_close_range
#define __NR_close_range 436
#endif
    if (syscall(__NR_close_range, 3U, ~0U, 0) != 0) {
        /* Fallback: iterate with a reasonable cap. The helper only
           opens a handful of fds; 1024 covers all realistic cases
           without the multi-second stall of iterating 1M fds. */
        for (int fd = 3; fd < 1024; fd++) {
            close(fd);  /* ignore EBADF */
        }
    }

    /* ── 7. Drop all capabilities ───────────────────────────────────── */

    /* Done BEFORE seccomp so capset doesn't need to be in the syscall
       allowlist. PR_SET_NO_NEW_PRIVS (already set) is sufficient for
       seccomp(SET_MODE_FILTER) — CAP_SYS_ADMIN is not required. */
    if (drop_capabilities() < 0) {
        die(EXIT_CAPS_ERROR, "capability drop failed");
    }

    /* ── 8. Install seccomp-BPF filter (last — locks syscalls for exec'd process) ── */

    if (install_seccomp_filter(&policy) < 0) {
        die(EXIT_SECCOMP_ERROR, "seccomp filter installation failed");
    }

    /* ── 9. exec the command ────────────────────────────────────────── */

    execvp(argv[cmd_start], &argv[cmd_start]);

    /* If we get here, execvp failed */
    fprintf(stderr, PREFIX "execvp(%s): %s\n",
            argv[cmd_start], strerror(errno));
    return EXIT_EXEC_ERROR;
}
