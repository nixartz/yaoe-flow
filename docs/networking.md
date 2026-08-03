# Networking: bind address, reverse proxy, custom domain

By default yaoe-flow only accepts connections from the machine it runs on. This page covers opening it up to other machines and putting it behind a domain/reverse proxy.

## Summary

- [HOST: who can reach yaoe-flow](#host-who-can-reach-yaoe-flow)
- [Custom domain / reverse proxy — no rebuild needed](#custom-domain--reverse-proxy--no-rebuild-needed)
- [Sample reverse proxy configs](#sample-reverse-proxy-configs)
- [HTTPS and the session cookie](#https-and-the-session-cookie)

## HOST: who can reach yaoe-flow

`HOST` (bootstrap setting, ENV-only) controls the bind address for both the API (`PORT`, default 4790) and the dashboard (`DASHBOARD_PORT`, default 4791) — they always share the same `HOST`.

| Value | Who can connect | When to use it |
|---|---|---|
| `localhost` (default) | Only processes on this machine | Workstation use, or a reverse proxy running on the **same** machine (it reaches yaoe-flow over loopback — no bind change needed) |
| `0.0.0.0` | Any machine that can route to this host | Direct LAN/internet access with no local proxy, or a reverse proxy running in a **different** container/machine |

`yaoe-flow setup` asks this in its "Network binding" step (first run, or later from the configuration menu). It writes `HOST` to `config.env` — the new value takes effect the next time `yaoe-flow daemon` starts.

Binding to `0.0.0.0` exposes both ports beyond this machine — pair it with a firewall (or your cloud provider's security group) limiting who can actually reach `PORT`/`DASHBOARD_PORT`, since neither is meant to be open to the raw internet without a reverse proxy in front.

## Custom domain / reverse proxy — no rebuild needed

If you want the dashboard reachable as `https://yaoe.example.com` instead of `http://server-ip:4791`, you do **not** need to rebuild the dashboard, edit any deployed file, or set any "API base URL". The dashboard SPA always calls its API with **relative paths** (`/api/...`, including the SSE streams) — it never hardcodes a host. Since the SPA and its API are served by the exact same process on `DASHBOARD_PORT` (`app/src/dashboard/server.ts`), whatever origin the browser loaded the page from is automatically the origin every subsequent request goes back to.

That means a reverse proxy that forwards `yaoe.example.com` (all paths) to `127.0.0.1:4791` just works — the browser never needs to know the internal address, and yaoe-flow never needs to know its own public domain.

Because the proxy talks to yaoe-flow over loopback, `HOST` can (and should) stay `localhost` in this setup — see the table above.

## Sample reverse proxy configs

**Caddy** (automatic HTTPS):

```
yaoe.example.com {
	reverse_proxy 127.0.0.1:4791
}
```

**nginx:**

```nginx
server {
	listen 443 ssl;
	server_name yaoe.example.com;

	location / {
		proxy_pass http://127.0.0.1:4791;
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-Proto $scheme;
		proxy_http_version 1.1; # required for SSE (Live/Logs streams)
		proxy_read_timeout 1h;  # SSE connections stay open — avoid mid-stream cutoffs
	}
}
```

If you also expose the main API port (`PORT`, for the Linear webhook), proxy it the same way on its own path/subdomain — it is a separate `Bun.serve()` instance from the dashboard.

## HTTPS and the session cookie

The dashboard session cookie is marked `Secure` only when `NODE_ENV=production` is set in yaoe-flow's own environment — which nothing sets by default. If you terminate TLS at the reverse proxy (recommended, as in the examples above), consider setting `NODE_ENV=production` in `config.env` so the cookie also gets the `Secure` flag; it has no effect on the proxy-to-backend hop, which stays plain HTTP over loopback either way.
