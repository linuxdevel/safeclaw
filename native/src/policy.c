#include "policy.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* ── tiny JSON tokenizer (recursive-descent, schema-specific) ─────────── */

typedef struct {
    const char *pos;
    const char *end;
    char *errbuf;
    int errbuf_size;
} Parser;

static void set_error(Parser *p, const char *msg)
{
    if (p->errbuf && p->errbuf_size > 0)
        snprintf(p->errbuf, (size_t)p->errbuf_size, "%s", msg);
}

static void skip_ws(Parser *p)
{
    while (p->pos < p->end &&
           (*p->pos == ' ' || *p->pos == '\t' ||
            *p->pos == '\n' || *p->pos == '\r'))
        p->pos++;
}

static int expect_char(Parser *p, char c)
{
    skip_ws(p);
    if (p->pos >= p->end || *p->pos != c) {
        char msg[64];
        snprintf(msg, sizeof(msg), "expected '%c'", c);
        set_error(p, msg);
        return -1;
    }
    p->pos++;
    return 0;
}

/* Parse a JSON string. Writes into dst (up to dst_size-1 chars + NUL).
   Returns 0 on success, -1 on error. Advances p->pos past closing quote. */
static int parse_string(Parser *p, char *dst, int dst_size)
{
    skip_ws(p);
    if (p->pos >= p->end || *p->pos != '"') {
        set_error(p, "expected '\"'");
        return -1;
    }
    p->pos++; /* skip opening quote */

    int i = 0;
    while (p->pos < p->end && *p->pos != '"') {
        char c = *p->pos;
        if (c == '\\') {
            p->pos++;
            if (p->pos >= p->end) {
                set_error(p, "unexpected end of string escape");
                return -1;
            }
            c = *p->pos;
            /* only handle \" and \\ – enough for paths */
            if (c != '"' && c != '\\' && c != '/' &&
                c != 'n' && c != 't' && c != 'r') {
                set_error(p, "unsupported escape in string");
                return -1;
            }
            if (c == 'n') c = '\n';
            else if (c == 't') c = '\t';
            else if (c == 'r') c = '\r';
        }
        if (i < dst_size - 1)
            dst[i++] = c;
        p->pos++;
    }

    if (p->pos >= p->end) {
        set_error(p, "unterminated string");
        return -1;
    }
    p->pos++; /* skip closing quote */

    if (dst_size > 0)
        dst[i] = '\0';
    return 0;
}

/* Skip a JSON string without storing it. */
static int skip_string(Parser *p)
{
    skip_ws(p);
    if (p->pos >= p->end || *p->pos != '"') {
        set_error(p, "expected '\"'");
        return -1;
    }
    p->pos++;
    while (p->pos < p->end && *p->pos != '"') {
        if (*p->pos == '\\') {
            p->pos++;
            if (p->pos >= p->end) {
                set_error(p, "unexpected end of string escape");
                return -1;
            }
        }
        p->pos++;
    }
    if (p->pos >= p->end) {
        set_error(p, "unterminated string");
        return -1;
    }
    p->pos++;
    return 0;
}

/* Parse a JSON boolean. Sets *out to 1 (true) or 0 (false).
   Returns 0 on success, -1 on error. */
static int parse_bool(Parser *p, int *out)
{
    skip_ws(p);
    if (p->pos + 4 <= p->end && memcmp(p->pos, "true", 4) == 0) {
        *out = 1;
        p->pos += 4;
        return 0;
    }
    if (p->pos + 5 <= p->end && memcmp(p->pos, "false", 5) == 0) {
        *out = 0;
        p->pos += 5;
        return 0;
    }
    set_error(p, "expected boolean");
    return -1;
}

/* Skip any JSON value (string, bool, object, array). No number support. */
static int skip_value(Parser *p);

static int skip_object(Parser *p)
{
    if (expect_char(p, '{') < 0) return -1;
    skip_ws(p);
    if (p->pos < p->end && *p->pos == '}') { p->pos++; return 0; }
    for (;;) {
        if (skip_string(p) < 0) return -1;
        skip_ws(p);
        if (expect_char(p, ':') < 0) return -1;
        if (skip_value(p) < 0) return -1;
        skip_ws(p);
        if (p->pos < p->end && *p->pos == ',') { p->pos++; continue; }
        break;
    }
    return expect_char(p, '}');
}

static int skip_array(Parser *p)
{
    if (expect_char(p, '[') < 0) return -1;
    skip_ws(p);
    if (p->pos < p->end && *p->pos == ']') { p->pos++; return 0; }
    for (;;) {
        if (skip_value(p) < 0) return -1;
        skip_ws(p);
        if (p->pos < p->end && *p->pos == ',') { p->pos++; continue; }
        break;
    }
    return expect_char(p, ']');
}

static int skip_value(Parser *p)
{
    skip_ws(p);
    if (p->pos >= p->end) { set_error(p, "unexpected end of input"); return -1; }
    switch (*p->pos) {
    case '"': return skip_string(p);
    case '{': return skip_object(p);
    case '[': return skip_array(p);
    case 't': case 'f': { int dummy; return parse_bool(p, &dummy); }
    case 'n': /* null */
        if (p->pos + 4 <= p->end && memcmp(p->pos, "null", 4) == 0) {
            p->pos += 4; return 0;
        }
        set_error(p, "unexpected token");
        return -1;
    default:
        /* JSON numbers: optional minus, digits, optional fraction/exponent */
        if (*p->pos == '-' || (*p->pos >= '0' && *p->pos <= '9')) {
            if (*p->pos == '-') p->pos++;
            if (p->pos >= p->end || *p->pos < '0' || *p->pos > '9') {
                set_error(p, "invalid number");
                return -1;
            }
            while (p->pos < p->end && *p->pos >= '0' && *p->pos <= '9')
                p->pos++;
            /* optional fraction */
            if (p->pos < p->end && *p->pos == '.') {
                p->pos++;
                while (p->pos < p->end && *p->pos >= '0' && *p->pos <= '9')
                    p->pos++;
            }
            /* optional exponent */
            if (p->pos < p->end && (*p->pos == 'e' || *p->pos == 'E')) {
                p->pos++;
                if (p->pos < p->end && (*p->pos == '+' || *p->pos == '-'))
                    p->pos++;
                while (p->pos < p->end && *p->pos >= '0' && *p->pos <= '9')
                    p->pos++;
            }
            return 0;
        }
        set_error(p, "unexpected token");
        return -1;
    }
}

/* ── access-string mapper ────────────────────────────────────────────── */

static int map_access(const char *s)
{
    if (strcmp(s, "read") == 0)      return ACCESS_READ;
    if (strcmp(s, "write") == 0)     return ACCESS_WRITE;
    if (strcmp(s, "readwrite") == 0) return ACCESS_READWRITE;
    if (strcmp(s, "execute") == 0)   return ACCESS_EXECUTE;
    if (strcmp(s, "readwriteexecute") == 0) return ACCESS_READWRITEEXECUTE;
    return -1;
}

/* ── parse a single fs rule object {"path":"…","access":"…"} ─────── */

static int parse_fs_rule(Parser *p, FsRule *rule)
{
    if (expect_char(p, '{') < 0) return -1;

    int got_path = 0, got_access = 0;
    char key[32];

    skip_ws(p);
    if (p->pos < p->end && *p->pos == '}') {
        set_error(p, "empty fs rule object");
        return -1;
    }

    for (;;) {
        if (parse_string(p, key, (int)sizeof(key)) < 0) return -1;
        if (expect_char(p, ':') < 0) return -1;

        if (strcmp(key, "path") == 0) {
            if (parse_string(p, rule->path, PATH_MAX) < 0) return -1;
            got_path = 1;
        } else if (strcmp(key, "access") == 0) {
            char access_str[32];
            if (parse_string(p, access_str, (int)sizeof(access_str)) < 0) return -1;
            rule->access = map_access(access_str);
            if (rule->access < 0) {
                char msg[96];
                snprintf(msg, sizeof(msg), "unknown access type: %s", access_str);
                set_error(p, msg);
                return -1;
            }
            got_access = 1;
        } else {
            if (skip_value(p) < 0) return -1;
        }

        skip_ws(p);
        if (p->pos < p->end && *p->pos == ',') { p->pos++; continue; }
        break;
    }

    if (expect_char(p, '}') < 0) return -1;

    if (!got_path) { set_error(p, "fs rule missing 'path'"); return -1; }
    if (!got_access) { set_error(p, "fs rule missing 'access'"); return -1; }
    return 0;
}

/* ── parse array of fs rules ─────────────────────────────────────────── */

static int parse_fs_rule_array(Parser *p, FsRule *rules, int max, int *count)
{
    if (expect_char(p, '[') < 0) return -1;
    *count = 0;

    skip_ws(p);
    if (p->pos < p->end && *p->pos == ']') { p->pos++; return 0; }

    for (;;) {
        if (*count >= max) {
            set_error(p, "too many fs rules");
            return -1;
        }
        if (parse_fs_rule(p, &rules[*count]) < 0) return -1;
        (*count)++;

        skip_ws(p);
        if (p->pos < p->end && *p->pos == ',') { p->pos++; continue; }
        break;
    }
    return expect_char(p, ']');
}

/* ── parse "filesystem" object ──────────────────────────────────────── */

static int parse_filesystem(Parser *p, Policy *out)
{
    if (expect_char(p, '{') < 0) return -1;

    skip_ws(p);
    if (p->pos < p->end && *p->pos == '}') { p->pos++; return 0; }

    char key[32];
    for (;;) {
        if (parse_string(p, key, (int)sizeof(key)) < 0) return -1;
        if (expect_char(p, ':') < 0) return -1;

        if (strcmp(key, "allow") == 0) {
            if (parse_fs_rule_array(p, out->allow, POLICY_MAX_ALLOW,
                                    &out->allow_count) < 0)
                return -1;
        } else if (strcmp(key, "deny") == 0) {
            if (parse_fs_rule_array(p, out->deny, POLICY_MAX_DENY,
                                    &out->deny_count) < 0)
                return -1;
        } else {
            if (skip_value(p) < 0) return -1;
        }

        skip_ws(p);
        if (p->pos < p->end && *p->pos == ',') { p->pos++; continue; }
        break;
    }
    return expect_char(p, '}');
}

/* ── parse string array (for syscalls.allow) ─────────────────────────── */

static int parse_string_array(Parser *p, char arr[][POLICY_SYSCALL_NAMELEN],
                              int max, int *count)
{
    if (expect_char(p, '[') < 0) return -1;
    *count = 0;

    skip_ws(p);
    if (p->pos < p->end && *p->pos == ']') { p->pos++; return 0; }

    for (;;) {
        if (*count >= max) {
            set_error(p, "too many syscalls");
            return -1;
        }
        if (parse_string(p, arr[*count], POLICY_SYSCALL_NAMELEN) < 0)
            return -1;
        (*count)++;

        skip_ws(p);
        if (p->pos < p->end && *p->pos == ',') { p->pos++; continue; }
        break;
    }
    return expect_char(p, ']');
}

/* ── parse "syscalls" object ─────────────────────────────────────────── */

static int parse_syscalls(Parser *p, Policy *out)
{
    if (expect_char(p, '{') < 0) return -1;

    skip_ws(p);
    if (p->pos < p->end && *p->pos == '}') { p->pos++; return 0; }

    char key[32];
    for (;;) {
        if (parse_string(p, key, (int)sizeof(key)) < 0) return -1;
        if (expect_char(p, ':') < 0) return -1;

        if (strcmp(key, "allow") == 0) {
            if (parse_string_array(p, out->syscalls, POLICY_MAX_SYSCALLS,
                                   &out->syscall_count) < 0)
                return -1;
        } else if (strcmp(key, "defaultDeny") == 0) {
            if (parse_bool(p, &out->default_deny) < 0) return -1;
        } else {
            if (skip_value(p) < 0) return -1;
        }

        skip_ws(p);
        if (p->pos < p->end && *p->pos == ',') { p->pos++; continue; }
        break;
    }
    return expect_char(p, '}');
}

/* ── top-level parser ────────────────────────────────────────────────── */

int policy_parse(const char *json, int len, Policy *out,
                 char *errbuf, int errbuf_size)
{
    if (!json || len <= 0) {
        if (errbuf && errbuf_size > 0)
            snprintf(errbuf, (size_t)errbuf_size, "empty policy input");
        return -1;
    }

    if (len > POLICY_MAX_SIZE) {
        if (errbuf && errbuf_size > 0)
            snprintf(errbuf, (size_t)errbuf_size, "policy exceeds 64 KiB limit");
        return -1;
    }

    memset(out, 0, sizeof(*out));

    Parser p;
    p.pos = json;
    p.end = json + len;
    p.errbuf = errbuf;
    p.errbuf_size = errbuf_size;

    if (expect_char(&p, '{') < 0) return -1;

    int got_fs = 0, got_sc = 0;
    char key[32];

    skip_ws(&p);
    if (p.pos < p.end && *p.pos == '}') {
        set_error(&p, "missing 'filesystem' section");
        return -1;
    }

    for (;;) {
        if (parse_string(&p, key, (int)sizeof(key)) < 0) return -1;
        if (expect_char(&p, ':') < 0) return -1;

        if (strcmp(key, "filesystem") == 0) {
            if (parse_filesystem(&p, out) < 0) return -1;
            got_fs = 1;
        } else if (strcmp(key, "syscalls") == 0) {
            if (parse_syscalls(&p, out) < 0) return -1;
            got_sc = 1;
        } else {
            if (skip_value(&p) < 0) return -1;
        }

        skip_ws(&p);
        if (p.pos < p.end && *p.pos == ',') { p.pos++; continue; }
        break;
    }

    if (expect_char(&p, '}') < 0) return -1;

    if (!got_fs) { set_error(&p, "missing 'filesystem' section"); return -1; }
    if (!got_sc) { set_error(&p, "missing 'syscalls' section"); return -1; }

    return 0;
}

/* ── read from file descriptor ───────────────────────────────────────── */

int policy_read_fd(int fd, Policy *out, char *errbuf, int errbuf_size)
{
    char buf[POLICY_MAX_SIZE];
    int total = 0;

    for (;;) {
        ssize_t n = read(fd, buf + total, (size_t)(POLICY_MAX_SIZE - total));
        if (n < 0) {
            if (errno == EINTR) continue;
            if (errbuf && errbuf_size > 0)
                snprintf(errbuf, (size_t)errbuf_size,
                         "read error: %s", strerror(errno));
            return -1;
        }
        if (n == 0) break;
        total += (int)n;
        if (total >= POLICY_MAX_SIZE) {
            if (errbuf && errbuf_size > 0)
                snprintf(errbuf, (size_t)errbuf_size,
                         "policy exceeds 64 KiB limit");
            return -1;
        }
    }

    return policy_parse(buf, total, out, errbuf, errbuf_size);
}

/* ── read from file path (with ownership/mode checks) ────────────────── */

int policy_read_file(const char *path, Policy *out,
                     char *errbuf, int errbuf_size)
{
    struct stat st;
    if (stat(path, &st) < 0) {
        if (errbuf && errbuf_size > 0)
            snprintf(errbuf, (size_t)errbuf_size,
                     "stat failed: %s", strerror(errno));
        return -1;
    }

    /* Must be owned by current user */
    if (st.st_uid != getuid()) {
        if (errbuf && errbuf_size > 0)
            snprintf(errbuf, (size_t)errbuf_size,
                     "policy file not owned by current user");
        return -1;
    }

    /* Must be mode 0600 (permission bits only) */
    if ((st.st_mode & 07777) != 0600) {
        if (errbuf && errbuf_size > 0)
            snprintf(errbuf, (size_t)errbuf_size,
                     "policy file mode must be 0600");
        return -1;
    }

    if (st.st_size > POLICY_MAX_SIZE) {
        if (errbuf && errbuf_size > 0)
            snprintf(errbuf, (size_t)errbuf_size,
                     "policy file exceeds 64 KiB limit");
        return -1;
    }

    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        if (errbuf && errbuf_size > 0)
            snprintf(errbuf, (size_t)errbuf_size,
                     "open failed: %s", strerror(errno));
        return -1;
    }

    int rc = policy_read_fd(fd, out, errbuf, errbuf_size);
    close(fd);
    return rc;
}
