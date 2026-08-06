# Cloudflare Worker TMDB Proxy

Edge-cached proxy for The Movie Database (TMDB) API designed for media clients.

## Features

- Edge Caching: Caches TMDB responses across Cloudflare CDN network.
- API Key Masking: Keeps TMDB API Key in environment secrets instead of client code.
- CORS Enabled: Supports cross-origin requests.

## Deployment

1. Install Wrangler CLI:
```bash
npm install -g wrangler
```

2. Login to Cloudflare:
```bash
npx wrangler login
```

3. Set your TMDB API Key secret:
```bash
npx wrangler secret put TMDB_API_KEY
```

4. Deploy the worker:
```bash
npx wrangler deploy
```

## Integration

In `NetworkModule.kt`, update the TMDB base URL to point to your worker URL:

```kotlin
@Provides
@Singleton
@Named("tmdb")
fun provideTmdbRetrofit(okHttpClient: OkHttpClient, moshi: Moshi): Retrofit =
    Retrofit.Builder()
        .baseUrl("https://cf-worker.<your-subdomain>.workers.dev/3/")
        .client(okHttpClient)
        .addConverterFactory(MoshiConverterFactory.create(moshi))
        .build()
```

## Local Development

```bash
npm run dev
```
