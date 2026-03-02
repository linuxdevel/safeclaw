#ifndef SAFECLAW_SECCOMP_H
#define SAFECLAW_SECCOMP_H

#include "policy.h"

/* Install seccomp-BPF filter based on policy syscall allowlist.
   Returns 0 on success, -1 on error. */
int install_seccomp_filter(const Policy *policy);

#endif
