#!/usr/bin/env python3
"""
Namecheap API Gateway for 301.st

Proxy-gateway between Cloudflare Workers and Namecheap API.
CF Workers cannot use standard HTTP proxies, so this service acts
as an intermediary: receives target URL from Worker, forwards it
through HTTP proxy with fallback, returns XML response.

Architecture:
    CF Worker -> VPS (this script) -> Proxy 1/2/3 -> Namecheap API

The gateway automatically replaces ClientIp parameter in the URL
with the IP of the proxy being used for each attempt.

# =============================================================
# LAUNCH
# =============================================================
#
# Direct:
#   python3 gateway.py
#
# Background (nohup):
#   nohup python3 /opt/301/gateway.py > /var/log/nc-gateway.log 2>&1 &
#
# Systemd service (/etc/systemd/system/nc-gateway.service):
#
#   [Unit]
#   Description=Namecheap API Gateway for 301.st
#   After=network.target
#
#   [Service]
#   Type=simple
#   User=www-data
#   ExecStart=/usr/bin/python3 /opt/301/gateway.py
#   Restart=always
#   RestartSec=5
#   StandardOutput=journal
#   StandardError=journal
#
#   [Install]
#   WantedBy=multi-user.target
#
# Then:
#   systemctl daemon-reload
#   systemctl enable nc-gateway
#   systemctl start nc-gateway
#   journalctl -u nc-gateway -f
#
# =============================================================
# NGINX (reverse proxy, optional)
# =============================================================
#
# If you want to put nginx in front (TLS termination, rate limiting):
#
# /etc/nginx/sites-available/nc-gateway:
#
#   server {
#       listen 443 ssl;
#       server_name gw.example.com;
#
#       ssl_certificate     /etc/letsencrypt/live/gw.example.com/fullchain.pem;
#       ssl_certificate_key /etc/letsencrypt/live/gw.example.com/privkey.pem;
#
#       location / {
#           proxy_pass http://127.0.0.1:8080;
#           proxy_set_header Host $host;
#           proxy_set_header X-Real-IP $remote_addr;
#           proxy_read_timeout 30s;
#           proxy_send_timeout 30s;
#
#           # Rate limiting (optional)
#           limit_req zone=gw burst=10 nodelay;
#       }
#   }
#
#   # In http block (/etc/nginx/nginx.conf):
#   # limit_req_zone $binary_remote_addr zone=gw:1m rate=10r/s;
#
# Then:
#   ln -s /etc/nginx/sites-available/nc-gateway /etc/nginx/sites-enabled/
#   nginx -t && systemctl reload nginx
#
# With nginx, change gateway PORT to 8080 (listen localhost only)
# and update KV to point to gw.example.com:443
#
# =============================================================
# TEST
# =============================================================
#
# Health check:
#   curl -s -o /dev/null -w "%{http_code}" http://localhost:8080
#   # Expected: 401
#
# Full test:
#   curl -X POST http://localhost:8080 \
#     -H "Authorization: Basic $(echo -n 'gw_user:gw_secret_pass' | base64)" \
#     -d "https://api.namecheap.com/xml.response?ApiUser=YOUR_USER&ApiKey=YOUR_KEY&UserName=YOUR_USER&Command=namecheap.users.getBalances&ClientIp=0.0.0.0"
#
# Expected (success):
#   <?xml version="1.0" encoding="utf-8"?>
#   <ApiResponse Status="OK" ...>
#     ...
#   </ApiResponse>
#
# Expected (auth fail):
#   401 Unauthorized
#
# Expected (all proxies down):
#   502 all_proxies_failed
#
# =============================================================
# KV CONFIGURATION (Cloudflare Workers)
# =============================================================
#
# Gateway credentials (used by CF Worker to connect):
#   wrangler kv:key put --binding=KV_CREDENTIALS "proxies:namecheap" \
#     '["VPS_IP:8080:gw_user:gw_secret_pass"]'
#
# Proxy IPs for user whitelist (shown in UI via GET /proxy-ips):
#   wrangler kv:key put --binding=KV_CREDENTIALS "proxy-ips:namecheap" \
#     '["185.218.1.220", "185.218.2.100", "172.252.57.50"]'
#
# =============================================================
"""

import http.server
import urllib.request
import base64
import re

# ── Config ───────────────────────────────────────────────────
PORT = 8080
AUTH_USER = 'gw_user'
AUTH_PASS = 'gw_secret_pass'

PROXIES = [
    {'ip': '185.218.1.220', 'port': 4319, 'user': 'user308440', 'pass': '5k4s12'},
    {'ip': '185.218.2.100', 'port': 4319, 'user': 'user308441', 'pass': 'abc123'},
    {'ip': '172.252.57.50', 'port': 4319, 'user': 'user308442', 'pass': 'xyz789'},
]
# ─────────────────────────────────────────────────────────────


def check_auth(headers):
    auth = headers.get('Authorization', '')
    if not auth.startswith('Basic '):
        return False
    decoded = base64.b64decode(auth[6:]).decode()
    return decoded == f'{AUTH_USER}:{AUTH_PASS}'


def replace_client_ip(url, proxy_ip):
    return re.sub(r'ClientIp=[^&]+', f'ClientIp={proxy_ip}', url)


def fetch_via_proxy(proxy, target_url):
    url = replace_client_ip(target_url, proxy['ip'])
    proxy_url = f"http://{proxy['user']}:{proxy['pass']}@{proxy['ip']}:{proxy['port']}"

    proxy_handler = urllib.request.ProxyHandler({'https': proxy_url, 'http': proxy_url})
    opener = urllib.request.build_opener(proxy_handler)

    try:
        req = urllib.request.Request(url)
        resp = opener.open(req, timeout=15)
        return {'ok': True, 'body': resp.read().decode(), 'proxy_ip': proxy['ip']}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if not check_auth(self.headers):
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b'Unauthorized')
            return

        length = int(self.headers.get('Content-Length', 0))
        target_url = self.rfile.read(length).decode().strip()

        if not target_url.startswith('https://'):
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'Invalid URL')
            return

        for proxy in PROXIES:
            print(f'[GW] Trying {proxy["ip"]}:{proxy["port"]}', flush=True)
            result = fetch_via_proxy(proxy, target_url)

            if result['ok']:
                print(f'[GW] Success via {proxy["ip"]}', flush=True)
                self.send_response(200)
                self.send_header('Content-Type', 'text/xml')
                self.send_header('X-Proxy-IP', result['proxy_ip'])
                self.end_headers()
                self.wfile.write(result['body'].encode())
                return

            print(f'[GW] Failed {proxy["ip"]}: {result["error"]}', flush=True)

        self.send_response(502)
        self.end_headers()
        self.wfile.write(b'all_proxies_failed')

    def log_message(self, fmt, *args):
        print(f'[GW] {args[0]}', flush=True)


if __name__ == '__main__':
    server = http.server.HTTPServer(('0.0.0.0', PORT), Handler)
    print(f'[GW] Listening on port {PORT}', flush=True)
    print(f'[GW] Proxies: {", ".join(p["ip"] for p in PROXIES)}', flush=True)
    server.serve_forever()
