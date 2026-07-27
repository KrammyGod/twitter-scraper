const http = require('http');
const Scraper = require('./scraper');
const EventEmitter = require('events');

const PORT = process.env.PORT || 5000;
const ready = new EventEmitter();
let started = false;
Scraper.start().then(() => {
    started = true;
    ready.emit('ready');
});

const server = http.createServer((req, res) => {
    const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);

    // Backs startup/liveness/readiness probes, all three off this one path.
    // 200 only once chromium is up AND still connected, so a browser that dies
    // mid-life takes the pod down with it instead of leaving it Ready and
    // returning empty results for every request.
    if (pathname === '/healthz') {
        const healthy = started && Scraper.isHealthy();
        return res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'text/plain' })
            .end(healthy ? 'ok' : 'browser not ready');
    }

    const url = searchParams.get('url');
    if (!url) return res.writeHead(400).end('No data here yet...');
    console.log(`Received request for "${url}"`);

    new Promise(resolve => {
        if (started) return resolve();
        ready.once('ready', resolve);
    }).then(() => {
        Scraper.getImageUrl(url).then(({ imgs, data }) => {
            const result = JSON.stringify({ imgs });
            console.log(`Completed request with result: ${result}`);
            if (req.headers['user-agent'] === 'node') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(result);
            }
            // If not our node requesting it and assuming it is browser, send a debug screenshot.
            res.writeHead(200, { 'Content-Type': 'image/png', imgs: JSON.stringify(imgs) });
            res.end(data);
        });
    });
});

server.listen(PORT, () => {
    console.log(`Scraper server listening on ${PORT}`);
});

// Ensure full cleanup on exit. Kubernetes sends SIGTERM and waits
// terminationGracePeriodSeconds before SIGKILL; closing the browser here is what
// keeps chromium from being orphaned when the pod is replaced.
let shuttingDown = false;
function cleanup() {
    // SIGTERM followed by an impatient Ctrl-C would otherwise run this twice and
    // close an already-closing context.
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    Scraper.end().then(() => {
        console.log('Finished cleaning up server.');
        process.exit(0);
    });
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
