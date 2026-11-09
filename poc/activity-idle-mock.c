// Synthetic Wayland server for activity-idle.c tests. Never connects to a desktop.
#define _GNU_SOURCE
#include <wayland-server.h>
#include "activity-idle-server-protocol.h"
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

static struct wl_display *display;
static struct wl_resource *probe, *notification;
static struct wl_event_source *timer;
static unsigned phase;
static const char *mode;
static pid_t child;
static void destroy_resource(struct wl_client *client, struct wl_resource *resource) { (void)client; wl_resource_destroy(resource); }
static void notification_destroyed(struct wl_resource *resource) {
    if (resource == probe) probe = NULL;
    if (resource == notification) notification = NULL;
}
static const struct ext_idle_notification_v1_interface notification_impl = { .destroy = destroy_resource };
static void make_notification(struct wl_client *client, struct wl_resource *manager, uint32_t id, uint32_t timeout, struct wl_resource *seat) {
    (void)seat;
    struct wl_resource *resource = wl_resource_create(client, &ext_idle_notification_v1_interface, wl_resource_get_version(manager), id);
    wl_resource_set_implementation(resource, &notification_impl, NULL, notification_destroyed);
    if (timeout == 1) {
        probe = resource;
        if (!strcmp(mode, "resume-without-idle")) ext_idle_notification_v1_send_resumed(probe);
        else {
            ext_idle_notification_v1_send_idled(probe);
            if (!strcmp(mode, "duplicate-idle")) ext_idle_notification_v1_send_idled(probe);
        }
    } else notification = resource;
}
static const struct ext_idle_notifier_v1_interface notifier_impl = {
    .destroy = destroy_resource, .get_idle_notification = make_notification, .get_input_idle_notification = make_notification
};
static void bind_notifier(struct wl_client *client, void *data, uint32_t version, uint32_t id) {
    (void)data;
    struct wl_resource *resource = wl_resource_create(client, &ext_idle_notifier_v1_interface, version, id);
    wl_resource_set_implementation(resource, &notifier_impl, NULL, NULL);
}
static void bind_seat(struct wl_client *client, void *data, uint32_t version, uint32_t id) {
    (void)data;
    struct wl_resource *resource = wl_resource_create(client, &wl_seat_interface, version, id);
    wl_resource_set_implementation(resource, NULL, NULL, NULL);
}
static int step(void *data) {
    (void)data;
    phase++;
    if (!strcmp(mode, "transitions")) {
        if (phase == 1 && probe) ext_idle_notification_v1_send_resumed(probe);
        if (phase == 2 && notification) ext_idle_notification_v1_send_idled(notification);
        if (phase == 3 && notification) ext_idle_notification_v1_send_resumed(notification);
    }
    if (!strcmp(mode, "disconnect") && phase == 1) wl_display_destroy_clients(display);
    wl_display_flush_clients(display);
    if (waitpid(child, NULL, WNOHANG) == child) { wl_display_terminate(display); return 0; }
    if (phase >= 5) { kill(child, SIGTERM); waitpid(child, NULL, 0); wl_display_terminate(display); return 0; }
    wl_event_source_timer_update(timer, 700);
    return 0;
}
int main(int argc, char **argv) {
    if (argc != 3) return 2;
    mode = argv[2];
    display = wl_display_create();
    if (!display) return 1;
    wl_global_create(display, &ext_idle_notifier_v1_interface, !strcmp(mode, "v1") ? 1 : 2, NULL, bind_notifier);
    if (strcmp(mode, "no-seat")) wl_global_create(display, &wl_seat_interface, 1, NULL, bind_seat);
    if (!strcmp(mode, "multi-seat")) wl_global_create(display, &wl_seat_interface, 1, NULL, bind_seat);
    int sockets[2], input[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) || pipe(input)) return 1;
    child = fork();
    if (child < 0) return 1;
    if (!child) {
        pid_t parent = getppid();
        prctl(PR_SET_PDEATHSIG, SIGTERM);
        if (getppid() != parent) _exit(1);
        close(sockets[0]); close(input[1]);
        dup2(input[0], STDIN_FILENO); close(input[0]);
        char fd[32]; snprintf(fd, sizeof(fd), "%d", sockets[1]);
        setenv("WAYLAND_SOCKET", fd, 1);
        execl(argv[1], argv[1], "1000", (char *)NULL);
        _exit(1);
    }
    close(sockets[1]); close(input[0]);
    wl_client_create(display, sockets[0]);
    timer = wl_event_loop_add_timer(wl_display_get_event_loop(display), step, NULL);
    wl_event_source_timer_update(timer, 700);
    wl_display_run(display);
    close(input[1]);
    wl_event_source_remove(timer);
    wl_display_destroy_clients(display);
    wl_display_destroy(display);
    return 0;
}
