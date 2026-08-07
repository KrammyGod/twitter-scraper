const http = require('http');
const Scraper = require('./scraper');

const PORT = process.env.PORT || 5000;
let started = false;
Scraper.start().then(() => {
    started = true;
});

http.createServer((req, res) => {
    const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);
    // Kubernetes probes. Not-ready until chromium is actually up, so a pod that
    // cannot launch the browser never receives a request.
    if (pathname === '/healthz') {
        const healthy = started && Scraper.isConnected();
        return res.writeHead(healthy ? 200 : 503).end(healthy ? 'ok' : 'starting');
    }

    const url = searchParams.get('url');
    if (!url) return res.writeHead(400).end('No data here yet...');
    console.log(`Received request for "${url}"`);

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
}).listen(PORT, () => {
    console.log(`Scraper server listening on ${PORT}`);
});

// Ensure full cleanup on exit.
function cleanup() {
    Scraper.end().then(() => {
        console.log('Finished cleaning up server.');
        process.exit(0);
    });
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
