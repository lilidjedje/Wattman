// Navigation must remain usable when the measurement hardware is offline.
(function (global) {
    let pending = null;
    let retry = null;
    let generation = 0;
    async function transmit(version) {
        const item = pending;
        if (!item || version !== generation) return;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        try {
            const response = await fetch(item.url, {method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(item.payload), signal: controller.signal});
            if (!response.ok) throw new Error('Écran momentanément indisponible.');
            if (version === generation) pending = null;
        } catch (error) {
            if (version === generation) retry = setTimeout(() => transmit(version).catch(() => {}), 3000);
            throw error;
        } finally { clearTimeout(timeout); }
    }
    global.DeviceDisplay = {
        cancel() {
            clearTimeout(retry);
            pending = null;
            generation += 1;
        },
        show(url, payload) {
            clearTimeout(retry);
            pending = {url, payload};
            generation += 1;
            return transmit(generation);
        }
    };
})(window);
