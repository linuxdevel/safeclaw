#ifndef SAFECLAW_CAPS_H
#define SAFECLAW_CAPS_H

/* Drop all Linux capabilities (effective, permitted, inheritable).
   Returns 0 on success, -1 on error. */
int drop_capabilities(void);

#endif
