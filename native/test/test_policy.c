#include "../src/policy.h"

#include <stdio.h>
#include <string.h>

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

static int parse(const char *json, Policy *p, char *err, int errsz)
{
    return policy_parse(json, (int)strlen(json), p, err, errsz);
}

/* ── test: minimal policy ────────────────────────────────────────────── */

static void test_minimal_policy(void)
{
    fprintf(stderr, "\ntest_minimal_policy:\n");
    const char *json =
        "{"
        "  \"filesystem\": {"
        "    \"allow\": ["
        "      { \"path\": \"/tmp\", \"access\": \"read\" }"
        "    ]"
        "  },"
        "  \"syscalls\": {"
        "    \"allow\": [\"read\", \"write\", \"exit\"],"
        "    \"defaultDeny\": true"
        "  }"
        "}";

    Policy p;
    char err[256] = {0};
    int rc = parse(json, &p, err, (int)sizeof(err));

    ASSERT(rc == 0, "parse succeeds");
    ASSERT(p.allow_count == 1, "one allow rule");
    ASSERT(strcmp(p.allow[0].path, "/tmp") == 0, "path is /tmp");
    ASSERT(p.allow[0].access == ACCESS_READ, "access is read");
    ASSERT(p.deny_count == 0, "no deny rules");
    ASSERT(p.syscall_count == 3, "three syscalls");
    ASSERT(strcmp(p.syscalls[0], "read") == 0, "syscall 0 is read");
    ASSERT(strcmp(p.syscalls[1], "write") == 0, "syscall 1 is write");
    ASSERT(strcmp(p.syscalls[2], "exit") == 0, "syscall 2 is exit");
    ASSERT(p.default_deny == 1, "defaultDeny is true");
}

/* ── test: full policy ───────────────────────────────────────────────── */

static void test_full_policy(void)
{
    fprintf(stderr, "\ntest_full_policy:\n");
    const char *json =
        "{"
        "  \"filesystem\": {"
        "    \"allow\": ["
        "      { \"path\": \"/usr/lib\", \"access\": \"read\" },"
        "      { \"path\": \"/var/data\", \"access\": \"readwrite\" },"
        "      { \"path\": \"/usr/bin/node\", \"access\": \"execute\" }"
        "    ],"
        "    \"deny\": ["
        "      { \"path\": \"/etc/shadow\", \"access\": \"read\" }"
        "    ]"
        "  },"
        "  \"syscalls\": {"
        "    \"allow\": [\"read\", \"write\", \"open\", \"close\", \"mmap\", \"exit_group\"],"
        "    \"defaultDeny\": true"
        "  }"
        "}";

    Policy p;
    char err[256] = {0};
    int rc = parse(json, &p, err, (int)sizeof(err));

    ASSERT(rc == 0, "parse succeeds");
    ASSERT(p.allow_count == 3, "three allow rules");
    ASSERT(strcmp(p.allow[0].path, "/usr/lib") == 0, "allow[0] path");
    ASSERT(p.allow[0].access == ACCESS_READ, "allow[0] access = read");
    ASSERT(strcmp(p.allow[1].path, "/var/data") == 0, "allow[1] path");
    ASSERT(p.allow[1].access == ACCESS_READWRITE, "allow[1] access = readwrite");
    ASSERT(strcmp(p.allow[2].path, "/usr/bin/node") == 0, "allow[2] path");
    ASSERT(p.allow[2].access == ACCESS_EXECUTE, "allow[2] access = execute");
    ASSERT(p.deny_count == 1, "one deny rule");
    ASSERT(strcmp(p.deny[0].path, "/etc/shadow") == 0, "deny[0] path");
    ASSERT(p.deny[0].access == ACCESS_READ, "deny[0] access = read");
    ASSERT(p.syscall_count == 6, "six syscalls");
    ASSERT(strcmp(p.syscalls[5], "exit_group") == 0, "last syscall is exit_group");
    ASSERT(p.default_deny == 1, "defaultDeny is true");
}

/* ── test: write access ──────────────────────────────────────────────── */

static void test_write_access(void)
{
    fprintf(stderr, "\ntest_write_access:\n");
    const char *json =
        "{"
        "  \"filesystem\": {"
        "    \"allow\": ["
        "      { \"path\": \"/var/log\", \"access\": \"write\" }"
        "    ]"
        "  },"
        "  \"syscalls\": {"
        "    \"allow\": [\"write\"],"
        "    \"defaultDeny\": true"
        "  }"
        "}";

    Policy p;
    char err[256] = {0};
    int rc = parse(json, &p, err, (int)sizeof(err));

    ASSERT(rc == 0, "parse succeeds");
    ASSERT(p.allow_count == 1, "one allow rule");
    ASSERT(strcmp(p.allow[0].path, "/var/log") == 0, "path is /var/log");
    ASSERT(p.allow[0].access == ACCESS_WRITE, "access is write (2)");
}

/* ── test: invalid JSON ──────────────────────────────────────────────── */

static void test_invalid_json(void)
{
    fprintf(stderr, "\ntest_invalid_json:\n");
    const char *json = "{ not valid json }";

    Policy p;
    char err[256] = {0};
    int rc = parse(json, &p, err, (int)sizeof(err));

    ASSERT(rc == -1, "parse fails on invalid JSON");
    ASSERT(strlen(err) > 0, "error message is set");
}

/* ── test: missing filesystem ────────────────────────────────────────── */

static void test_missing_filesystem(void)
{
    fprintf(stderr, "\ntest_missing_filesystem:\n");
    const char *json =
        "{"
        "  \"syscalls\": {"
        "    \"allow\": [\"read\"],"
        "    \"defaultDeny\": true"
        "  }"
        "}";

    Policy p;
    char err[256] = {0};
    int rc = parse(json, &p, err, (int)sizeof(err));

    ASSERT(rc == -1, "parse fails without filesystem");
    ASSERT(strlen(err) > 0, "error message is set");
}

/* ── test: missing syscalls ──────────────────────────────────────────── */

static void test_missing_syscalls(void)
{
    fprintf(stderr, "\ntest_missing_syscalls:\n");
    const char *json =
        "{"
        "  \"filesystem\": {"
        "    \"allow\": ["
        "      { \"path\": \"/tmp\", \"access\": \"read\" }"
        "    ]"
        "  }"
        "}";

    Policy p;
    char err[256] = {0};
    int rc = parse(json, &p, err, (int)sizeof(err));

    ASSERT(rc == -1, "parse fails without syscalls");
    ASSERT(strlen(err) > 0, "error message is set");
}

/* ── test: empty policy ──────────────────────────────────────────────── */

static void test_empty_policy(void)
{
    fprintf(stderr, "\ntest_empty_policy:\n");

    Policy p;
    char err[256] = {0};
    int rc = policy_parse("", 0, &p, err, (int)sizeof(err));

    ASSERT(rc == -1, "parse fails on empty string");
    ASSERT(strlen(err) > 0, "error message is set");
}

/* ── test: unknown access type ───────────────────────────────────────── */

static void test_unknown_access(void)
{
    fprintf(stderr, "\ntest_unknown_access:\n");
    const char *json =
        "{"
        "  \"filesystem\": {"
        "    \"allow\": ["
        "      { \"path\": \"/tmp\", \"access\": \"delete\" }"
        "    ]"
        "  },"
        "  \"syscalls\": {"
        "    \"allow\": [\"read\"],"
        "    \"defaultDeny\": true"
        "  }"
        "}";

    Policy p;
    char err[256] = {0};
    int rc = parse(json, &p, err, (int)sizeof(err));

    ASSERT(rc == -1, "parse fails on unknown access");
    ASSERT(strlen(err) > 0, "error message is set");
}

/* ── test: defaultDeny false ─────────────────────────────────────────── */

static void test_default_deny_false(void)
{
    fprintf(stderr, "\ntest_default_deny_false:\n");
    const char *json =
        "{"
        "  \"filesystem\": {"
        "    \"allow\": ["
        "      { \"path\": \"/tmp\", \"access\": \"read\" }"
        "    ]"
        "  },"
        "  \"syscalls\": {"
        "    \"allow\": [\"read\"],"
        "    \"defaultDeny\": false"
        "  }"
        "}";

    Policy p;
    char err[256] = {0};
    int rc = parse(json, &p, err, (int)sizeof(err));

    ASSERT(rc == 0, "parse succeeds");
    ASSERT(p.default_deny == 0, "defaultDeny is false");
    ASSERT(p.allow_count == 1, "one allow rule");
    ASSERT(p.syscall_count == 1, "one syscall");
}

/* ── main ────────────────────────────────────────────────────────────── */

int main(void)
{
    fprintf(stderr, "=== policy parser tests ===\n");

    test_minimal_policy();
    test_full_policy();
    test_write_access();
    test_invalid_json();
    test_missing_filesystem();
    test_missing_syscalls();
    test_empty_policy();
    test_unknown_access();
    test_default_deny_false();

    fprintf(stderr, "\n%d/%d tests passed\n", tests_passed, tests_run);
    return (tests_passed == tests_run) ? 0 : 1;
}
