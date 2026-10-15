'use strict';
const crypto = require('crypto');

function buildHtml(cspSource, cssUri, coreUri, jsUri) {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:; base-uri 'none'; form-action 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
<title>AI Delivery Insights</title>
</head>
<body>
<div class="progress"><i id="bar"></i></div>
<div class="wrap" id="app"></div>
<div id="live" class="sr" role="status" aria-live="polite"></div>
<script nonce="${nonce}" src="${coreUri}"></script>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

module.exports = { buildHtml };
