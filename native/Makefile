CC      ?= musl-gcc
CFLAGS  := -std=c11 -Wall -Wextra -Werror -pedantic -O2 \
           -D_GNU_SOURCE -static
LDFLAGS := -static

PREFIX  ?= /usr/local
BINDIR  := $(PREFIX)/bin

SRC     := src/main.c src/policy.c src/landlock.c src/seccomp.c src/caps.c
OBJ     := $(SRC:.c=.o)
BIN     := safeclaw-sandbox-helper

TEST_BINS := test/test-policy test/test-syscall-table test/test-seccomp \
             test/test-landlock test/test-caps

.PHONY: all clean install check test-bins

all: $(BIN)

$(BIN): $(OBJ)
	$(CC) $(LDFLAGS) -o $@ $^

%.o: %.c
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -f $(OBJ) $(BIN) $(TEST_BINS)

install: $(BIN)
	install -Dm755 $(BIN) $(DESTDIR)$(BINDIR)/$(BIN)

test-bins: $(BIN) $(TEST_BINS)

test/test-policy: src/policy.o test/test_policy.c
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ test/test_policy.c src/policy.o

test/test-syscall-table: test/test_syscall_table.c src/syscall_table.h
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ test/test_syscall_table.c

test/test-seccomp: src/seccomp.o src/policy.o test/test_seccomp.c
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ test/test_seccomp.c src/seccomp.o src/policy.o

test/test-landlock: src/landlock.o src/policy.o test/test_landlock.c
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ test/test_landlock.c src/landlock.o src/policy.o

test/test-caps: src/caps.o test/test_caps.c
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ test/test_caps.c src/caps.o

check: test-bins
	./test/run-tests.sh
