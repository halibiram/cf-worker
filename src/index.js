/**
 * Cloudflare Worker TMDB Caching Proxy
 * Repository: https://github.com/halibiram/cf-worker
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept-Language',
  'Access-Control-Max-Age': '86400',
};

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

    // Health check endpoint
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'TMDB Caching Proxy' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      });
    }

    // Inject TMDB API key if set in environment secrets and not explicitly provided in request
    if (env.TMDB_API_KEY && !url.searchParams.has('api_key')) {
      url.searchParams.set('api_key', env.TMDB_API_KEY);
    }

    // Target upstream URL on TMDB API
    const targetUrl = `https://api.themoviedb.org${url.pathname}${url.search}`;

    // Create a cache key based on normalized request URL
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), {
      method: 'GET',
      headers: {
        'Accept-Language': request.headers.get('Accept-Language') || 'en-US',
      },
    });

    // Check Cloudflare Edge Cache
    let cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      // Add custom header to indicate Cache HIT
      const responseHeaders = new Headers(cachedResponse.headers);
      responseHeaders.set('X-Proxy-Cache', 'HIT');
      Object.entries(CORS_HEADERS).forEach(([k, v]) => responseHeaders.set(k, v));

      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        statusText: cachedResponse.statusText,
        headers: responseHeaders,
      });
    }

    // Fetch from TMDB Upstream
    try {
      const tmdbResponse = await fetch(targetUrl, {
        method: request.method,
        headers: {
          'Accept': 'application/json',
          'Accept-Language': request.headers.get('Accept-Language') || 'en-US',
          'User-Agent': 'Nuvio-TMDB-Worker/1.0',
        },
      });

      const responseHeaders = new Headers(tmdbResponse.headers);

      // Apply CORS headers
      Object.entries(CORS_HEADERS).forEach(([k, v]) => responseHeaders.set(k, v));

      if (tmdbResponse.ok) {
        // Cache successful responses on Cloudflare Edge (24 hours client, 7 days edge)
        responseHeaders.set('Cache-Control', 'public, max-age=86400, s-maxage=604800');
        responseHeaders.set('X-Proxy-Cache', 'MISS');

        const responseToReturn = new Response(tmdbResponse.body, {
          status: tmdbResponse.status,
          statusText: tmdbResponse.statusText,
          headers: responseHeaders,
        });

        // Store copy in Cloudflare Cache asynchronously
        ctx.waitUntil(cache.put(cacheKey, responseToReturn.clone()));

        return responseToReturn;
      } else {
        // Do not cache error responses
        responseHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        responseHeaders.set('X-Proxy-Cache', 'BYPASS');

        return new Response(tmdbResponse.body, {
          status: tmdbResponse.status,
          statusText: tmdbResponse.statusText,
          headers: responseHeaders,
        });
      }
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Upstream Fetch Failed', details: error.message }), {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      });
    }
  },
};
