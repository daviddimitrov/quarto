// Service Worker nur für Push, kein Caching
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
    let data;
    try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
    const jobs = [self.registration.showNotification(data.title || 'Quarto', {
        body: data.body || '',
        icon: 'assets/images/apple-touch-icon.png',
        tag: data.tag || 'quarto',
        data: { url: data.url || './' },
    })];
    // Zahl am App-Icon auch aktualisieren, wenn die App gerade nicht offen ist
    if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
        jobs.push((data.badge ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => {}));
    }
    event.waitUntil(Promise.all(jobs));
});

// Tipp auf die Nachricht öffnet die App oder holt sie nach vorn
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        for (const client of list) {
            if ('focus' in client) return client.focus();
        }
        return self.clients.openWindow(event.notification.data.url);
    }));
});
