#ifndef SAFECLAW_POLICY_H
#define SAFECLAW_POLICY_H

#include <limits.h>

#define POLICY_MAX_SIZE       (64 * 1024)  /* 64 KiB */
#define POLICY_MAX_ALLOW      64
#define POLICY_MAX_DENY       16
#define POLICY_MAX_SYSCALLS   256
#define POLICY_SYSCALL_NAMELEN 32

/* Access levels for filesystem rules */
#define ACCESS_READ       1
#define ACCESS_WRITE      2
#define ACCESS_READWRITE  3
#define ACCESS_EXECUTE    4

/* Exit codes */
#define EXIT_POLICY_ERROR    70
#define EXIT_LANDLOCK_ERROR  71
#define EXIT_SECCOMP_ERROR   72
#define EXIT_CAPS_ERROR      73
#define EXIT_EXEC_ERROR      74
#define EXIT_PERM_ERROR      75
#define EXIT_ARCH_ERROR      76

typedef struct {
    char path[PATH_MAX];
    int access;
} FsRule;

typedef struct {
    FsRule allow[POLICY_MAX_ALLOW];
    int allow_count;
    FsRule deny[POLICY_MAX_DENY];
    int deny_count;
    char syscalls[POLICY_MAX_SYSCALLS][POLICY_SYSCALL_NAMELEN];
    int syscall_count;
    int default_deny;
} Policy;

/* Parse JSON policy from a buffer. Returns 0 on success, -1 on error.
   On error, errbuf contains a human-readable message. */
int policy_parse(const char *json, int len, Policy *out, char *errbuf, int errbuf_size);

/* Read policy from fd 3. Returns 0 on success, -1 on error. */
int policy_read_fd(int fd, Policy *out, char *errbuf, int errbuf_size);

/* Read policy from a file path. Checks mode 0600 and uid ownership.
   Returns 0 on success, -1 on error. */
int policy_read_file(const char *path, Policy *out, char *errbuf, int errbuf_size);

#endif /* SAFECLAW_POLICY_H */
