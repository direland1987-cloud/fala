import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const types = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};
http
  .createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const p = path.join(process.cwd(), 'public', name === '/' ? 'index.html' : name);
    if (!p.startsWith(path.join(process.cwd(), 'public'))) {
      res.writeHead(403);
      return res.end();
    }
    try {
      res.setHeader('Content-Type', types[path.extname(p)] || 'text/plain');
      res.end(fs.readFileSync(p));
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  })
  .listen(Number(process.env.PORT || 3000), '0.0.0.0', () =>
    console.log('Fala ready on port ' + (process.env.PORT || 3000)),
  );
