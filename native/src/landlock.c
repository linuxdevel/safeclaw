#include "landlock.h"

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/syscall.h>

/* O_PATH may not be defined in all libc headers */
#ifndef O_PATH
#define O_PATH 010000000
#endif

/* ── syscall numbers (may not be defined in musl/glibc headers) ────── */

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

/* ── landlock constants and structures ─────────────────────────────── */

#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#define LANDLOCK_RULE_PATH_BENEATH 1

/* ABI v1 access rights */
#define LANDLOCK_ACCESS_FS_EXECUTE    (1ULL << 0)
#define LANDLOCK_ACCESS_FS_WRITE_FILE (1ULL << 1)
#define LANDLOCK_ACCESS_FS_READ_FILE  (1ULL << 2)
#define LANDLOCK_ACCESS_FS_READ_DIR   (1ULL << 3)
#define LANDLOCK_ACCESS_FS_REMOVE_DIR (1ULL << 4)
#define LANDLOCK_ACCESS_FS_REMOVE_FILE (1ULL << 5)
#define LANDLOCK_ACCESS_FS_MAKE_CHAR  (1ULL << 6)
#define LANDLOCK_ACCESS_FS_MAKE_DIR   (1ULL << 7)
#define LANDLOCK_ACCESS_FS_MAKE_REG   (1ULL << 8)
#define LANDLOCK_ACCESS_FS_MAKE_SOCK  (1ULL << 9)
#define LANDLOCK_ACCESS_FS_MAKE_FIFO  (1ULL << 10)
#define LANDLOCK_ACCESS_FS_MAKE_BLOCK (1ULL << 11)
#define LANDLOCK_ACCESS_FS_MAKE_SYM   (1ULL << 12)

/* ABI v2 */
#define LANDLOCK_ACCESS_FS_REFER      (1ULL << 13)

/* ABI v3 */
#define LANDLOCK_ACCESS_FS_TRUNCATE   (1ULL << 14)

struct landlock_ruleset_attr {
    uint64_t handled_access_fs;
};

struct landlock_path_beneath_attr {
    uint64_t allowed_access;
    int32_t  parent_fd;
} __attribute__((packed));

/* ── error macro ───────────────────────────────────────────────────── */

#define ERR(fmt, ...) \
    fprintf(stderr, "safeclaw-sandbox-helper: error: " fmt "\n", ##__VA_ARGS__)

/* ── ABI detection ─────────────────────────────────────────────────── */

static int landlock_abi_version(void)
{
    int abi = (int)syscall(__NR_landlock_create_ruleset, NULL, 0,
                           LANDLOCK_CREATE_RULESET_VERSION);
    return abi;
}

/* ── access mask for a given ABI version ───────────────────────────── */

static uint64_t handled_access_for_abi(int abi)
{
    uint64_t access =
        LANDLOCK_ACCESS_FS_EXECUTE    |
        LANDLOCK_ACCESS_FS_WRITE_FILE |
        LANDLOCK_ACCESS_FS_READ_FILE  |
        LANDLOCK_ACCESS_FS_READ_DIR   |
        LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE |
        LANDLOCK_ACCESS_FS_MAKE_CHAR  |
        LANDLOCK_ACCESS_FS_MAKE_DIR   |
        LANDLOCK_ACCESS_FS_MAKE_REG   |
        LANDLOCK_ACCESS_FS_MAKE_SOCK  |
        LANDLOCK_ACCESS_FS_MAKE_FIFO  |
        LANDLOCK_ACCESS_FS_MAKE_BLOCK |
        LANDLOCK_ACCESS_FS_MAKE_SYM;

    if (abi >= 2)
        access |= LANDLOCK_ACCESS_FS_REFER;
    if (abi >= 3)
        access |= LANDLOCK_ACCESS_FS_TRUNCATE;

    return access;
}

/* ── map policy access level to landlock rights ────────────────────── */

static uint64_t policy_access_to_landlock(int access_level, int abi)
{
    uint64_t rights = 0;

    if (access_level == ACCESS_READ || access_level == ACCESS_READWRITE) {
        rights |= LANDLOCK_ACCESS_FS_READ_FILE |
                   LANDLOCK_ACCESS_FS_READ_DIR;
    }

    if (access_level == ACCESS_WRITE || access_level == ACCESS_READWRITE) {
        rights |= LANDLOCK_ACCESS_FS_WRITE_FILE |
                   LANDLOCK_ACCESS_FS_READ_FILE  |
                   LANDLOCK_ACCESS_FS_READ_DIR   |
                   LANDLOCK_ACCESS_FS_REMOVE_FILE |
                   LANDLOCK_ACCESS_FS_REMOVE_DIR |
                   LANDLOCK_ACCESS_FS_MAKE_REG   |
                   LANDLOCK_ACCESS_FS_MAKE_DIR   |
                   LANDLOCK_ACCESS_FS_MAKE_SYM;
        if (abi >= 2)
            rights |= LANDLOCK_ACCESS_FS_REFER;
        if (abi >= 3)
            rights |= LANDLOCK_ACCESS_FS_TRUNCATE;
    }

    if (access_level == ACCESS_EXECUTE) {
        rights |= LANDLOCK_ACCESS_FS_EXECUTE |
                   LANDLOCK_ACCESS_FS_READ_FILE |
                   LANDLOCK_ACCESS_FS_READ_DIR;
    }

    return rights;
}

/* ── access rights valid on file vs directory fds ─────────────────── */

/*
 * Landlock's RULE_PATH_BENEATH only permits a subset of access rights
 * when the fd refers to a regular file (not a directory).  Specifically,
 * only EXECUTE, WRITE_FILE, READ_FILE (and TRUNCATE on ABI ≥ 3) are
 * valid for file fds.  All other rights (READ_DIR, REMOVE_*, MAKE_*,
 * REFER) are directory-only and cause EINVAL if applied to a file fd.
 *
 * We detect files via fstat() and mask off the directory-only bits.
 */
static uint64_t file_valid_rights(int abi)
{
    uint64_t rights = LANDLOCK_ACCESS_FS_EXECUTE    |
                      LANDLOCK_ACCESS_FS_WRITE_FILE |
                      LANDLOCK_ACCESS_FS_READ_FILE;
    if (abi >= 3)
        rights |= LANDLOCK_ACCESS_FS_TRUNCATE;
    return rights;
}

/* ── apply_landlock ────────────────────────────────────────────────── */

int apply_landlock(const Policy *policy)
{
    /* 1. Probe ABI version */
    int abi = landlock_abi_version();
    if (abi < 0) {
        if (errno == ENOSYS || errno == EOPNOTSUPP) {
            return 1; /* Landlock not available — graceful */
        }
        ERR("landlock ABI probe failed: %s", strerror(errno));
        return -1;
    }

    /* 2. Build handled_access_fs mask */
    uint64_t handled = handled_access_for_abi(abi);

    struct landlock_ruleset_attr attr;
    memset(&attr, 0, sizeof(attr));
    attr.handled_access_fs = handled;

    /* 3. Create ruleset */
    int ruleset_fd = (int)syscall(__NR_landlock_create_ruleset,
                                  &attr, sizeof(attr), 0);
    if (ruleset_fd < 0) {
        ERR("landlock_create_ruleset failed: %s", strerror(errno));
        return -1;
    }

    /* 4. Add allow rules */
    for (int i = 0; i < policy->allow_count; i++) {
        const FsRule *rule = &policy->allow[i];

        int path_fd = open(rule->path, O_PATH | O_CLOEXEC);
        if (path_fd < 0) {
            if (errno == ENOENT) {
                /* Path doesn't exist on this system — skip silently.
                 * The policy may list paths like /usr/local/lib64 that
                 * only exist on some distributions. */
                continue;
            }
            ERR("cannot open path '%s': %s", rule->path, strerror(errno));
            close(ruleset_fd);
            return -1;
        }

        uint64_t allowed = policy_access_to_landlock(rule->access, abi);
        /* Mask to only rights we declared as handled */
        allowed &= handled;

        /*
         * If the path is a regular file (not a directory), strip
         * directory-only access rights.  Landlock returns EINVAL
         * if directory-only rights are used on a file fd.
         */
        struct stat st;
        if (fstat(path_fd, &st) == 0 && !S_ISDIR(st.st_mode)) {
            allowed &= file_valid_rights(abi);
        }

        /* If no rights remain after masking, skip this rule —
         * adding a rule with zero allowed_access is EINVAL. */
        if (allowed == 0) {
            close(path_fd);
            continue;
        }

        struct landlock_path_beneath_attr path_attr;
        memset(&path_attr, 0, sizeof(path_attr));
        path_attr.allowed_access = allowed;
        path_attr.parent_fd = (int32_t)path_fd;

        int ret = (int)syscall(__NR_landlock_add_rule, ruleset_fd,
                               LANDLOCK_RULE_PATH_BENEATH,
                               &path_attr, 0);
        close(path_fd);

        if (ret < 0) {
            ERR("landlock_add_rule failed for '%s': %s",
                rule->path, strerror(errno));
            close(ruleset_fd);
            return -1;
        }
    }

    /* Skip deny rules — Landlock is allowlist-only; deny is for Node.js logging */

    /* 5. Restrict self */
    int ret = (int)syscall(__NR_landlock_restrict_self, ruleset_fd, 0);
    if (ret < 0) {
        ERR("landlock_restrict_self failed: %s", strerror(errno));
        close(ruleset_fd);
        return -1;
    }

    /* 6. Close ruleset fd */
    close(ruleset_fd);

    return 0;
}
