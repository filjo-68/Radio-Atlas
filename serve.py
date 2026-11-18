"""Serve Rádio Atlas and count active listening sessions in memory."""

import argparse
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from mimetypes import guess_type
from pathlib import Path
import re
from threading import Lock
from time import monotonic
from urllib.parse import parse_qs, unquote, urlsplit


ROOT = Path(__file__).resolve().parent
COUNTRY_CODES = {path.stem.upper() for path in (ROOT / 'data').glob('??.json')}
SESSION_TTL = 300
MAX_SESSIONS = 10_000
MAX_REQUEST_BYTES = 131_072
STATIC_PATH = re.compile(
    r'/(?:index\.html|(?:app|data|player|stats|sw|i18n|translations)\.js|styles\.css|manifest\.webmanifest|'
    r'assets/(?:hero\.webp|flags/[a-z]{2}\.png)|data/[a-z]{2}\.json|'
    r'icons/(?:icon-192|icon-512|maskable-512|apple-touch-icon)\.png|'
    r'vendor/hls\.light\.min\.mjs)'
)
STATS_META = b'<meta name="radio-stats-api" content="">'


def station_id(value):
    return isinstance(value, str) and 0 < len(value) <= 2048 and value.isprintable()


def country_code(value):
    return isinstance(value, str) and value in COUNTRY_CODES


class Listeners:
    def __init__(self):
        self.sessions = {}
        self.lock = Lock()

    def counts(self, heartbeat=None):
        now = monotonic()
        with self.lock:
            expired = [
                key for key, (_, _, expiry) in self.sessions.items() if expiry <= now
            ]
            for key in expired:
                del self.sessions[key]
            if heartbeat:
                key, country, station, listening = heartbeat
                if listening:
                    if key not in self.sessions and len(self.sessions) >= MAX_SESSIONS:
                        return None
                    self.sessions[key] = country, station, now + SESSION_TTL
                else:
                    self.sessions.pop(key, None)

            countries = Counter()
            stations = Counter()
            for country, station, _ in self.sessions.values():
                countries[country] += 1
                stations[country, station] += 1
            return len(self.sessions), countries, stations


class RadioHandler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(8)
        super().setup()

    def do_HEAD(self):
        self.serve_asset(head_only=True)

    def do_GET(self):
        self.serve_asset()

    def serve_asset(self, head_only=False):
        path = unquote(urlsplit(self.path).path)
        if path == '/':
            path = '/index.html'
        if not STATIC_PATH.fullmatch(path):
            self.send_error(404)
            return
        try:
            asset = (ROOT / path[1:]).resolve()
            if not asset.is_relative_to(ROOT):
                self.send_error(404)
                return
            body = asset.read_bytes()
        except OSError:
            self.send_error(404)
            return
        if path == '/index.html':
            body = body.replace(
                STATS_META, b'<meta name="radio-stats-api" content="./stats.php">', 1
            )
        mime = {
            '/manifest.webmanifest': 'application/manifest+json',
            '/vendor/hls.light.min.mjs': 'text/javascript',
        }.get(path) or guess_type(path)[0] or 'application/octet-stream'
        self.reply(200, mime, body, head_only=head_only)

    def reply(self, status, mime, body, head_only=False):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def json_reply(self, status, value):
        body = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
        self.reply(status, 'application/json; charset=utf-8', body)

    def do_POST(self):
        target = urlsplit(self.path)
        if target.path != '/stats.php':
            self.send_error(404)
            return
        origin = self.headers.get('Origin')
        if origin and origin not in (
            f"http://{self.headers.get('Host')}", f"https://{self.headers.get('Host')}"
        ):
            self.json_reply(403, {'error': 'Origin mismatch'})
            return
        if self.headers.get_content_type() != 'application/json' or self.headers.get('Transfer-Encoding'):
            self.json_reply(415, {'error': 'Expected a JSON request with Content-Length'})
            return
        try:
            query = parse_qs(target.query, max_num_fields=3)
            lengths = self.headers.get_all('Content-Length', [])
            length = int(lengths[0]) if len(lengths) == 1 else 0
            if not 0 < length <= MAX_REQUEST_BYTES:
                self.json_reply(413, {'error': 'Request size is outside the allowed range'})
                return
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError('Expected a JSON object')
            status, body = self.stats_response(query, payload)
            self.json_reply(status, body)
        except (ValueError, RecursionError, TimeoutError):
            self.json_reply(400, {'error': 'Invalid statistics request'})

    def stats_response(self, query, payload):
        action = query.get('action')
        counters = self.server.listeners
        if action == ['countries']:
            codes = payload.get('countries')
            if not isinstance(codes, list) or len(codes) > 300 or not all(map(country_code, codes)):
                raise ValueError('Invalid countries')
            total, countries, _ = counters.counts()
            return 200, {'listeners': total, 'countries': {code: countries[code] for code in codes}}

        if action == ['stations']:
            country = query.get('country', [None])[0]
            ids = payload.get('station_ids')
            if not country_code(country) or not isinstance(ids, list) or len(ids) > 1500 or not all(map(station_id, ids)):
                raise ValueError('Invalid station query')
            total, countries, stations = counters.counts()
            return 200, {
                'listeners': total,
                'country_listeners': countries[country],
                'stations': {sid: stations[country, sid] for sid in ids},
            }

        if action == ['heartbeat']:
            key, country = payload.get('session_id'), payload.get('country')
            sid, listening = payload.get('station_id'), payload.get('listening')
            if (
                not isinstance(key, str) or not re.fullmatch(r'[a-f0-9]{32}', key)
                or not country_code(country) or not station_id(sid) or not isinstance(listening, bool)
            ):
                raise ValueError('Invalid heartbeat')
            result = counters.counts((key, country, sid, listening))
            if result is None:
                return 503, {'error': 'Listener counter is at capacity'}
            total, countries, _ = result
            return 200, {'listeners': total, 'country_listeners': countries[country]}

        raise ValueError('Unknown statistics action')


class RadioServer(ThreadingHTTPServer):
    def __init__(self, address):
        super().__init__(address, RadioHandler)
        self.listeners = Listeners()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bind', default='127.0.0.1', help='listen address')
    parser.add_argument('--port', default=8080, type=int, help='listen port')
    args = parser.parse_args()
    with RadioServer((args.bind, args.port)) as server:
        print(f'Радио Атлас · http://{args.bind}:{server.server_port}/', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
