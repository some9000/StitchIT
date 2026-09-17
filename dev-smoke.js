// dev-smoke.js — generates and serves browser harness pages from index.html
// Usage: node dev-smoke.js [plain|deep|regression] [&workers] [&large] [&status] [&drawing]
// Pages: /dev-smoke.html, /dev-smoke-deep.html, /dev-regression.html
const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

const ROOT = __dirname;
const PORT = 8139;
const TEMP_DIR = process.env.TEMP || process.env.TMP || '/tmp';
const RESULTS_FILE = path.join(TEMP_DIR, 's360-smoke-results.txt');

const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function injectScript(html, scriptPath) {
  const scriptTag = `<script src="${scriptPath}"></script>`;
  const marker = '<script src="gpu-memory.js"></script>';
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error('Application script marker missing from index.html');
  return html.slice(0, idx) + scriptTag + '\n' + html.slice(idx);
}

// The harness script reads its flags (workers/large/status/drawing) and its
// mode from the page URL the user opens, so all three pages get the same
// injected script; generatePage still validates the mode for CLI safety.
function generatePage(mode) {
  if (!['plain', 'deep', 'regression'].includes(mode)) {
    throw new Error('Unknown mode: ' + mode);
  }

  // Inject before application scripts so worker stubs and dependency wrappers
  // are installed before the app registers its DOMContentLoaded handler.
  return injectScript(indexHtml, '/dev-browser-regression.js');
}

const pages = {
  '/dev-smoke.html': generatePage('plain'),
  '/dev-smoke-deep.html': generatePage('deep'),
  '/dev-regression.html': generatePage('regression'),
};

function appendResults(text) {
  try {
    fs.appendFileSync(RESULTS_FILE, text + '\n\n');
  } catch (e) {
    console.warn('Failed to write results file:', e.message);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  
  // CORS headers for local testing
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  if (pathname === '/report') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      console.log('\n=== TEST REPORT ===\n' + body);
      appendResults(body);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    });
    return;
  }
  
  // Serve generated pages
  if (pages[pathname]) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(pages[pathname]);
    return;
  }
  
  // Serve static files from project root
  const filePath = path.join(ROOT, pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.mjs': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.wasm': 'application/wasm',
      '.txt': 'text/plain',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found: ' + pathname);
});

function startServer(mode, extraArgs = '') {
  // Clear previous results file
  try { fs.writeFileSync(RESULTS_FILE, ''); } catch (_) {}
  
  server.listen(PORT, '127.0.0.1', () => {
    const pageMap = {
      'plain': '/dev-smoke.html',
      'deep': '/dev-smoke-deep.html',
      'regression': '/dev-regression.html',
    };
    const page = pageMap[mode] || '/dev-smoke.html';
    const url = `http://127.0.0.1:${PORT}${page}${extraArgs ? '?' + extraArgs : ''}`;
    console.log(`\n🚀 StitchIT Smoke Server running at http://127.0.0.1:${PORT}`);
    console.log(`📄 Opening: ${url}`);
    console.log(`📝 Results will be appended to: ${RESULTS_FILE}`);
    console.log('\nPress Ctrl+C to stop the server.\n');
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use. Is another dev-smoke.js running?`);
    process.exit(1);
  }
  throw err;
});

// Parse command line arguments
const args = process.argv.slice(2);
const mode = args[0] || 'plain';
const validModes = ['plain', 'deep', 'regression'];
if (!validModes.includes(mode)) {
  console.error(`Usage: node dev-smoke.js [${validModes.join('|')}] [extra query args]`);
  console.error('Example: node dev-smoke.js regression &workers &large');
  process.exit(1);
}

const extraArgs = args.slice(1).join(' &');
startServer(mode, extraArgs);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  server.close(() => {
    console.log('✅ Server stopped.');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
