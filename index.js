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

http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`).searchParams.get('url');
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
// Sent by pm2
process.on('message', message => {
    if (message === 'shutdown') cleanup();
});
