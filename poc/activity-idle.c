// Read-only ext-idle-notify v2 client. No surfaces, input devices, inhibitors,
// lock requests, titles, process metadata or input-event payloads are acquired.
#define _GNU_SOURCE
#include <wayland-client.h>
#include "activity-idle-protocol.h"
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <time.h>
#include <unistd.h>

static struct wl_display *display;
static struct wl_seat *seat;
static struct ext_idle_notifier_v1 *notifier;
static struct ext_idle_notification_v1 *notification, *probe;
static struct wl_callback *sync_callback;
static uint32_t seat_name, notifier_name;
static unsigned seats;
static const char *kind = "activity-unavailable";
static int failed, synced, notification_idle, probe_idle;
static double last_sync, last_ack, last_loop, last_suspend;
static volatile sig_atomic_t stopping;
static void stop_signal(int signum) { (void)signum; stopping = 1; }
static double seconds(clockid_t clock) {
    struct timespec t;
    if (clock_gettime(clock, &t) < 0) exit(1);
    return t.tv_sec + t.tv_nsec / 1e9;
}
static void emit(void) {
    printf("{\"version\":1,\"kind\":\"%s\"}\n", kind);
    if (fflush(stdout) != 0) stopping = 1;
}
static void idled(void *data, struct ext_idle_notification_v1 *object) {
    (void)data;
    if (failed) return;
    int *was_idle = object == notification ? &notification_idle : &probe_idle;
    if (*was_idle) { failed = 1; kind = "activity-unavailable"; return; }
    *was_idle = 1;
    if (object == notification) kind = "idle";
}
static void resumed(void *data, struct ext_idle_notification_v1 *object) {
    (void)data;
    if (failed) return;
    int *was_idle = object == notification ? &notification_idle : &probe_idle;
    if (!*was_idle) { failed = 1; kind = "activity-unavailable"; return; }
    *was_idle = 0;
    if (object == probe) {
        // Initial non-idle status is not evidence of recent input. A 1ms
        // notification must first idle and then resume; destroy it immediately
        // afterward. Zero is unsuitable: Hyprland never resumes a zero timer.
        ext_idle_notification_v1_destroy(probe);
        probe = NULL;
    }
    kind = "active";
}
static const struct ext_idle_notification_v1_listener idle_listener = { idled, resumed };
static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
    (void)data;
    if (!strcmp(interface, "wl_seat")) {
        seats++;
        if (!seat) { seat_name = name; seat = wl_registry_bind(registry, name, &wl_seat_interface, 1); }
    }
    if (!strcmp(interface, "ext_idle_notifier_v1") && version >= 2 && !notifier) {
        notifier_name = name;
        notifier = wl_registry_bind(registry, name, &ext_idle_notifier_v1_interface, 2);
    }
}
static void removed(void *data, struct wl_registry *registry, uint32_t name) {
    (void)data; (void)registry;
    if (name == seat_name || name == notifier_name) failed = 1;
}
static const struct wl_registry_listener registry_listener = { global, removed };
static void sync_done(void *data, struct wl_callback *callback, uint32_t serial) {
    (void)data; (void)serial;
    wl_callback_destroy(callback);
    sync_callback = NULL;
    synced = 1;
    last_ack = seconds(CLOCK_MONOTONIC);
    emit(); // Heartbeat requires a fresh compositor round trip.
}
static const struct wl_callback_listener sync_listener = { sync_done };
static void start_sync(void) {
    sync_callback = wl_display_sync(display);
    wl_callback_add_listener(sync_callback, &sync_listener, NULL);
    last_sync = seconds(CLOCK_MONOTONIC);
}
int main(int argc, char **argv) {
    char *end = NULL;
    unsigned long timeout = argc == 2 ? strtoul(argv[1], &end, 10) : 0;
    if (argc != 2 || !end || *end || timeout < 1000 || timeout > 86400000) return 2;
    signal(SIGTERM, stop_signal); signal(SIGINT, stop_signal); signal(SIGPIPE, stop_signal);
    pid_t parent = getppid();
    if (parent == 1 || prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 || getppid() != parent) return 1;
    display = wl_display_connect(NULL);
    if (!display) return 1;
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    last_loop = last_ack = seconds(CLOCK_MONOTONIC);
    last_suspend = seconds(CLOCK_BOOTTIME) - last_loop;
    start_sync();
    while (!stopping && !failed) {
        double now = seconds(CLOCK_MONOTONIC);
        double suspend = seconds(CLOCK_BOOTTIME) - now;
        // Exit on suspend/stalls; caller restarts with no stale idle state.
        if (now - last_loop > 2 || suspend - last_suspend > .25 || now - last_ack > 1.5) break;
        last_loop = now; last_suspend = suspend;
        if (synced && !notification) {
            if (!notifier || !seat || seats != 1) break;
            notification = ext_idle_notifier_v1_get_input_idle_notification(notifier, timeout, seat);
            probe = ext_idle_notifier_v1_get_input_idle_notification(notifier, 1, seat);
            ext_idle_notification_v1_add_listener(notification, &idle_listener, NULL);
            ext_idle_notification_v1_add_listener(probe, &idle_listener, NULL);
        }
        if (seats > 1) break; // Never silently pick one of several seats.
        if (!sync_callback && now - last_sync >= .5) start_sync();
        if (wl_display_dispatch_pending(display) < 0) break;
        if (wl_display_flush(display) < 0 && errno != EAGAIN) break;
        struct pollfd fds[] = {{wl_display_get_fd(display), POLLIN, 0}, {STDIN_FILENO, POLLIN, 0}};
        int result = poll(fds, 2, 100);
        if (result < 0) { if (errno == EINTR) continue; break; }
        if (fds[1].revents) break; // EOF/HUP or any parent message cancels.
        if (fds[0].revents & (POLLERR | POLLHUP | POLLNVAL)) break;
        if ((fds[0].revents & POLLIN) && wl_display_dispatch(display) < 0) break;
    }
    kind = "activity-unavailable"; emit();
    if (sync_callback) wl_callback_destroy(sync_callback);
    if (probe) ext_idle_notification_v1_destroy(probe);
    if (notification) ext_idle_notification_v1_destroy(notification);
    if (notifier) ext_idle_notifier_v1_destroy(notifier);
    if (seat) wl_seat_destroy(seat);
    wl_registry_destroy(registry);
    wl_display_disconnect(display);
    return stopping ? 0 : 1;
}
