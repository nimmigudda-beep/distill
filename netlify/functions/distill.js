/* ═══════════════════════════════════════════
   DISTILL — Netlify Serverless Proxy
   Keeps your Groq API key safe server-side
═══════════════════════════════════════════ */

const https = require('https');

// Simple in-memory rate limiter (10 requests/minute per IP)
const requests = {};

function isRateLimited(ip) {
  const now = Date.now();
  if (!requests[ip]) requests[ip] = [];
  requests[ip] = requests[ip].filter(t => now - t < 60000);
  if (requests[ip].length >= 10) return true;
  requests[ip].push(now);
  return false;
}

function httpsPost(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.GROQ_API_KEY,
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => { responseData += chunk; });
      res.on('end', () => {
        console.log('Groq status:', res.statusCode);
        console.log('Groq response:', responseData.slice(0, 200));
        resolve({ status: res.statusCode, body: responseData });
      });
    });
    req.on('error', (e) => {
      console.error('Request error:', e.message);
      reject(e);
    });
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.write(data);
    req.end();
  });
}

exports.handler = async function(event) {
  console.log('Function called, method:', event.httpMethod);

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Method not allowed' } })
    };
  }

  // Check API key is configured
  if (!process.env.GROQ_API_KEY) {
    console.error('GROQ_API_KEY not set');
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'API key not configured on server' } })
    };
  }

  // Rate limit by IP
  const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Too many requests — please wait a moment.' } })
    };
  }

  try {
    if (!event.body) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { message: 'Empty request body' } })
      };
    }

    const body = JSON.parse(event.body);
    if (body.max_tokens && body.max_tokens > 2048) body.max_tokens = 2048;

    const result = await httpsPost(body);

    // Make sure we got something back
    if (!result.body || result.body.trim() === '') {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { message: 'Empty response from Groq API' } })
      };
    }

    return {
      statusCode: result.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: result.body
    };
  } catch (err) {
    console.error('Handler error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Proxy error: ' + err.message } })
    };
  }
};
