#ifndef SAFECLAW_LANDLOCK_H
#define SAFECLAW_LANDLOCK_H

#include "policy.h"

/* Apply Landlock filesystem restrictions based on policy.
   Returns: 0 on success, 1 if Landlock is not supported (graceful), -1 on error. */
int apply_landlock(const Policy *policy);

#endif
