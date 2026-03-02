#include "caps.h"
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Capability header/data structs — defined inline since musl may not have
   <linux/capability.h> with _LINUX_CAPABILITY_VERSION_3 */

#define SAFECLAW_LINUX_CAPABILITY_VERSION_3  0x20080522
#define SAFECLAW_LINUX_CAPABILITY_U32S_3     2

struct safeclaw_cap_header {
    unsigned int version;
    int pid;
};

struct safeclaw_cap_data {
    unsigned int effective;
    unsigned int permitted;
    unsigned int inheritable;
};

int drop_capabilities(void) {
    struct safeclaw_cap_header hdr;
    struct safeclaw_cap_data data[SAFECLAW_LINUX_CAPABILITY_U32S_3];

    memset(&hdr, 0, sizeof(hdr));
    memset(data, 0, sizeof(data));

    hdr.version = SAFECLAW_LINUX_CAPABILITY_VERSION_3;
    hdr.pid = 0;  /* current process */

    /* data is already zeroed = no capabilities in any set */

    if (syscall(SYS_capset, &hdr, data) != 0) {
        fprintf(stderr, "safeclaw-sandbox-helper: error: capset failed: %s\n",
                strerror(errno));
        return -1;
    }

    return 0;
}
