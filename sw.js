"use strict";
// Service worker: shows the daily reminder. Pushes carry no data, so the text is fixed here.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  e.waitUntil(self.registration.showNotification("Money Manager", {
    body: "Time to add today's spending. It takes a minute.",
    icon: "/apple-touch-icon.png",
    badge: "/apple-touch-icon.png",
    tag: "daily-reminder",
    renotify: true,
    data: { url: "/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow("/");
  }));
});
