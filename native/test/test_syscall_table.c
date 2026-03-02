#include "../src/syscall_table.h"

#include <stdio.h>

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

int main(void)
{
    fprintf(stderr, "=== syscall table tests ===\n\n");

    /* well-known syscall numbers */
    ASSERT(syscall_lookup("read") == 0, "read is syscall 0");
    ASSERT(syscall_lookup("write") == 1, "write is syscall 1");
    ASSERT(syscall_lookup("open") == 2, "open is syscall 2");
    ASSERT(syscall_lookup("close") == 3, "close is syscall 3");
    ASSERT(syscall_lookup("exit_group") == 231, "exit_group is syscall 231");
    ASSERT(syscall_lookup("execve") == 59, "execve is syscall 59");
    ASSERT(syscall_lookup("mmap") == 9, "mmap is syscall 9");
    ASSERT(syscall_lookup("brk") == 12, "brk is syscall 12");
    ASSERT(syscall_lookup("clone") == 56, "clone is syscall 56");
    ASSERT(syscall_lookup("getpid") == 39, "getpid is syscall 39");

    /* negative cases */
    ASSERT(syscall_lookup("nonexistent_syscall") == -1, "nonexistent_syscall returns -1");
    ASSERT(syscall_lookup("") == -1, "empty string returns -1");
    ASSERT(syscall_lookup("READ") == -1, "READ (uppercase) returns -1 (case sensitive)");
    ASSERT(syscall_lookup(NULL) == -1, "NULL returns -1");

    fprintf(stderr, "\n%d/%d tests passed\n", tests_passed, tests_run);
    return (tests_passed == tests_run) ? 0 : 1;
}
