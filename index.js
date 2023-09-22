require('dotenv/config');
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

    new Promise(resolve => {
        if (started) return resolve();
        ready.once('ready', resolve);
    }).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        Scraper.getImageUrl(url).then(imgs => {
            res.end(JSON.stringify({ imgs }))
        }).catch(() => {
            res.end(JSON.stringify({ imgs: [url] }));
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
    }).catch(() => {
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
