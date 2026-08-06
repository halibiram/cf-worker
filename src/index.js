/**
 * Cloudflare Worker Proxy & Cache for TMDB, Cinemeta & Metahub Images
 * Advanced Performance Optimizations:
 * 1. Native Cache API (caches.default) + ctx.waitUntil for background revalidation
 * 2. JSON Minification & Payload Optimization
 * 3. WebP/AVIF Image Header Optimization
 * 4. Tiered Edge Caching with Stale-While-Revalidate
 *
 * Repository: https://github.com/halibiram/cf-worker
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept-Language',
  'Access-Control-Max-Age': '86400',
};

// Helper: Minify JSON payload to save bandwidth & speed up parsing
function minifyJson(jsonString) {
  try {
    const parsed = JSON.parse(jsonString);
    return JSON.stringify(parsed);
  } catch (e) {
    return jsonString;
  }
}

export default {
  async fetch(request, env, ctx) {
    // Handle OPTIONS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // Only allow GET and HEAD requests
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      });
    }

    const url = new URL(request.url);
    const workerOrigin = url.origin;
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);

    // 1. Check Native Cloudflare Cache API for instant HIT (<5ms)
    let cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      const responseHeaders = new Headers(cachedResponse.headers);
      responseHeaders.set('X-Worker-Cache', 'HIT');
      Object.entries(CORS_HEADERS).forEach(([k, v]) => responseHeaders.set(k, v));

      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        statusText: cachedResponse.statusText,
        headers: responseHeaders,
      });
    }

    // Health check endpoint
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'TMDB, Cinemeta & Metahub Proxy (Optimized)' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      });
    }

    // --- A. METAHUB IMAGES PROXY (/metahub/...) ---
    if (url.pathname.startsWith('/metahub')) {
      const metahubPath = url.pathname.replace(/^\/metahub/, '');
      const targetUrl = `https://images.metahub.space${metahubPath}${url.search}`;

      const metahubReq = new Request(targetUrl, {
        method: request.method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });

      try {
        const imageRes = await fetch(metahubReq, {
          redirect: 'follow',
          cf: {
            cacheTtl: 2592000, // 30 days edge cache on Cloudflare CDN
            cacheEverything: true,
          },
        });

        const responseHeaders = new Headers(imageRes.headers);
        Object.entries(CORS_HEADERS).forEach(([k, v]) => responseHeaders.set(k, v));
        responseHeaders.set('Cache-Control', 'public, max-age=2592000, s-maxage=2592000, stale-while-revalidate=604800');
        responseHeaders.set('X-Worker-Cache', 'MISS');

        const finalResponse = new Response(imageRes.body, {
          status: imageRes.status,
          statusText: imageRes.statusText,
          headers: responseHeaders,
        });

        if (imageRes.ok) {
          ctx.waitUntil(cache.put(cacheKey, finalResponse.clone()));
        }

        return finalResponse;
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Metahub Proxy Failed', details: error.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    }

    // --- B. CINEMETA PROXY (/cinemeta/...) ---
    if (url.pathname.startsWith('/cinemeta')) {
      const cinemetaPath = url.pathname.replace(/^\/cinemeta/, '') || '/manifest.json';
      const targetUrl = `https://v3-cinemeta.strem.io${cinemetaPath}${url.search}`;

      const cinemetaReq = new Request(targetUrl, {
        method: request.method,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Cinemeta-Worker/1.0',
        },
      });

      try {
        const cinemetaRes = await fetch(cinemetaReq, {
          redirect: 'follow',
          cf: {
            cacheTtl: 604800, // 7 days edge cache
            cacheEverything: true,
          },
        });

        const responseHeaders = new Headers(cinemetaRes.headers);
        Object.entries(CORS_HEADERS).forEach(([k, v]) => responseHeaders.set(k, v));
        responseHeaders.set('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400');
        responseHeaders.set('X-Worker-Cache', 'MISS');

        const contentType = cinemetaRes.headers.get('content-type') || '';
        let bodyContent = cinemetaRes.body;

        if (contentType.includes('application/json')) {
          let jsonText = await cinemetaRes.text();
          // Rewrite blocked metahub.space URLs to our unblocked Cloudflare worker proxy
          jsonText = jsonText.replace(/https:\/\/images\.metahub\.space/g, `${workerOrigin}/metahub`);
          // Minify JSON payload for maximum speed & bandwidth efficiency
          jsonText = minifyJson(jsonText);

          const finalResponse = new Response(jsonText, {
            status: cinemetaRes.status,
            statusText: cinemetaRes.statusText,
            headers: responseHeaders,
          });

          if (cinemetaRes.ok) {
            ctx.waitUntil(cache.put(cacheKey, finalResponse.clone()));
          }

          return finalResponse;
        }

        const finalResponse = new Response(bodyContent, {
          status: cinemetaRes.status,
          statusText: cinemetaRes.statusText,
          headers: responseHeaders,
        });

        if (cinemetaRes.ok) {
          ctx.waitUntil(cache.put(cacheKey, finalResponse.clone()));
        }

        return finalResponse;
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Cinemeta Upstream Failed', details: error.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    }

    // --- C. TMDB PROXY (/3/...) ---
    if (env.TMDB_API_KEY && !url.searchParams.has('api_key')) {
      url.searchParams.set('api_key', env.TMDB_API_KEY);
    }

    const targetUrl = `https://api.themoviedb.org${url.pathname}${url.search}`;

    const tmdbReq = new Request(targetUrl, {
      method: request.method,
      headers: {
        'Accept': 'application/json',
        'Accept-Language': request.headers.get('Accept-Language') || 'en-US',
        'User-Agent': 'TMDB-Worker/1.0',
      },
    });

    try {
      const tmdbResponse = await fetch(tmdbReq, {
        redirect: 'follow',
        cf: {
          cacheTtl: 604800, // 7 days edge cache
          cacheEverything: true,
        },
      });

      const responseHeaders = new Headers(tmdbResponse.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => responseHeaders.set(k, v));

      if (tmdbResponse.ok) {
        responseHeaders.set('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400');
        responseHeaders.set('X-Worker-Cache', 'MISS');

        let jsonText = await tmdbResponse.text();
        jsonText = minifyJson(jsonText);

        const finalResponse = new Response(jsonText, {
          status: tmdbResponse.status,
          statusText: tmdbResponse.statusText,
          headers: responseHeaders,
        });

        ctx.waitUntil(cache.put(cacheKey, finalResponse.clone()));
        return finalResponse;
      } else {
        responseHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        return new Response(tmdbResponse.body, {
          status: tmdbResponse.status,
          statusText: tmdbResponse.statusText,
          headers: responseHeaders,
        });
      }
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Upstream Fetch Failed', details: error.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  },
};
