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

// Create a running queue to handle requests sequentially.
const queue = [];
let running = false;
function dequeue() {
    if (queue.length === 0) {
        running = false;
        return;
    }
    const { promise, cb } = queue.shift();
    running = true;
    promise.then(res => {
        cb(res);
        dequeue();
    });
}
/**
 * Adds a function to the queue to be executed.
 * @param {PromiseLike<T>} promise The asynchronous function to enqueue.
 * @param {(arg: T) => any} cb The callback to call with the result of the function.
 */
function enqueue(promise, cb) {
    queue.push({ promise, cb });
    if (!running) {
        dequeue();
    }
}

http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`).searchParams.get('url');
    if (!url) return res.writeHead(400).end('No data here yet...');

    new Promise(resolve => {
        if (started) return resolve();
        ready.once('ready', resolve);
    }).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        enqueue(Scraper.getImageUrl(url), imgs => res.end(JSON.stringify({ imgs })));
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
