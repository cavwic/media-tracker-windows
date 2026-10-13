"""Bounded metadata-only bridge. Never downloads media or executes site scripts.

The public edition uses only yt_dlp.YoutubeDL.extract_info(download=False,
process=False). gallery-dl is not imported, shipped, or automatically installed.
No CLI config loads.
"""
import datetime
import hashlib
import http.client
import http.cookiejar
import ipaddress
import json
import logging
import os
import re
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request

MAX_METADATA_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_BYTES = 12 * 1024 * 1024
MAX_INPUT_BYTES = 12 * 1024 * 1024
IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "tiff"}


class SourceError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class BudgetReached(Exception):
    pass


def public_ip(value):
    try:
        address = ipaddress.ip_address(value)
        return address.is_global and not address.is_multicast and not getattr(address, "ipv4_mapped", None) and not getattr(address, "sixtofour", None) and not getattr(address, "teredo", None)
    except ValueError:
        return False


def checked_url(value):
    try:
        url = urllib.parse.urlsplit(value)
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.port not in (None, 443):
            raise ValueError()
        if url.hostname.endswith(".") or url.hostname.lower() in {"localhost", "localhost.localdomain"}:
            raise ValueError()
        # Non-public numeric hosts are rejected even before a DNS lookup.
        try:
            ipaddress.ip_address(url.hostname)
        except ValueError:
            pass
        else:
            if not public_ip(url.hostname):
                raise ValueError()
        return url
    except (ValueError, TypeError):
        raise SourceError("unsafe-url") from None


def same_host(first, second):
    return first.lower().removeprefix("www.") == second.lower().removeprefix("www.")


class LimitedReader:
    def __init__(self, reader, deadline):
        self.reader = reader
        self.original_read = reader.read
        self.count = 0
        self.deadline = deadline

    def __getattr__(self, name):
        return getattr(self.reader, name)

    def read(self, amount=-1, *args, **kwargs):
        if time.monotonic() > self.deadline:
            raise SourceError("metadata-timeout")
        amount = min(amount if amount is not None and amount >= 0 else MAX_METADATA_BYTES + 1,
                     MAX_METADATA_BYTES + 1 - self.count)
        data = self.original_read(amount, *args, **kwargs)
        self.count += len(data)
        if self.count > MAX_METADATA_BYTES:
            raise SourceError("metadata-too-large")
        return data

    def stream(self, amount=65536, decode_content=None):
        while True:
            chunk = self.read(amount, decode_content=decode_content)
            if not chunk:
                return
            yield chunk


def install_network_guards(homepage, deadline):
    """Protect DNS/socket destinations and each requests/urllib redirect hop."""
    home_host = checked_url(homepage).hostname
    original_dns = socket.getaddrinfo
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex

    def guarded_dns(host, port, *args, **kwargs):
        if time.monotonic() > deadline:
            raise SourceError("metadata-timeout")
        answers = original_dns(host, port, *args, **kwargs)
        if not answers or any(not public_ip(item[4][0]) for item in answers):
            raise SourceError("unsafe-url")
        return answers

    def destination(address):
        if not isinstance(address, tuple) or len(address) < 2 or address[1] != 443:
            raise SourceError("unsafe-url")
        if not public_ip(address[0]):
            raise SourceError("unsafe-url")

    def guarded_connect(sock, address):
        destination(address)
        return original_connect(sock, address)

    def guarded_connect_ex(sock, address):
        destination(address)
        return original_connect_ex(sock, address)

    socket.getaddrinfo = guarded_dns
    socket.socket.connect = guarded_connect
    socket.socket.connect_ex = guarded_connect_ex
    original_http_read = http.client.HTTPResponse.read
    def bounded_http_read(response, amount=None):
        count = getattr(response, "_mt_bytes", 0)
        limit = min(amount if amount is not None and amount >= 0 else MAX_METADATA_BYTES + 1,
                    MAX_METADATA_BYTES + 1 - count)
        data = original_http_read(response, limit)
        response._mt_bytes = count + len(data)
        if response._mt_bytes > MAX_METADATA_BYTES or time.monotonic() > deadline:
            raise SourceError("metadata-too-large")
        return data
    http.client.HTTPResponse.read = bounded_http_read
    # No local explicit proxy can silently bypass the public-address guard.
    for variable in list(os.environ):
        if variable.lower() in {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}:
            os.environ.pop(variable, None)
    import requests
    original_send = requests.Session.send

    def guarded_send(session, request, **kwargs):
        redirects = []
        follow = kwargs.pop("allow_redirects", True)
        kwargs.update(allow_redirects=False, stream=True, proxies={}, timeout=20)
        for _ in range(6):
            url = checked_url(request.url)
            if request.method.upper() not in {"GET", "HEAD"}:
                raise SourceError("read-only-method-required")
            guarded_dns(url.hostname, 443)
            if not same_host(url.hostname, home_host):
                request.headers.pop("Cookie", None)
                request.headers.pop("Authorization", None)
            response = original_send(session, request, **kwargs)
            response.raw = LimitedReader(response.raw, deadline)
            if not follow or response.status_code not in (301, 302, 303, 307, 308) or "location" not in response.headers:
                response.history = redirects
                return response
            target = urllib.parse.urljoin(request.url, response.headers["location"])
            checked_url(target)
            redirects.append(response)
            response.close()
            headers = {key: value for key, value in request.headers.items() if key.lower() not in {"cookie", "authorization", "host"}}
            request = session.prepare_request(requests.Request("GET", target, headers=headers))
        raise SourceError("redirect-limit")

    requests.Session.send = guarded_send
    original_open = urllib.request.OpenerDirector.open
    original_add_cookie = http.cookiejar.CookieJar.add_cookie_header

    def guarded_add_cookie(jar, request):
        if same_host(checked_url(request.get_full_url()).hostname, home_host):
            return original_add_cookie(jar, request)

    def guarded_open(opener, request, data=None, timeout=20):
        value = request if isinstance(request, str) else request.full_url
        url = checked_url(value)
        method = "GET" if isinstance(request, str) else request.get_method()
        if data is not None or method not in {"GET", "HEAD"}:
            raise SourceError("read-only-method-required")
        guarded_dns(url.hostname, 443)
        if not isinstance(request, str) and not same_host(url.hostname, home_host):
            request.remove_header("Cookie")
            request.remove_header("Authorization")
        result = original_open(opener, request, timeout=20)
        # The networking handler reads this response; bound metadata memory.
        result.read = LimitedReader(result, deadline).read if not hasattr(result, "_mt_limited") else result.read
        result._mt_limited = True
        return result

    urllib.request.OpenerDirector.open = guarded_open
    http.cookiejar.CookieJar.add_cookie_header = guarded_add_cookie
    # Extractors cannot spawn JS engines, browsers, ffmpeg or shell helpers.
    def denied_process(*args, **kwargs):
        raise SourceError("external-helper-required")
    subprocess.Popen = denied_process
    os.system = denied_process


def date_string(value):
    if isinstance(value, datetime.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=datetime.timezone.utc)
        return value.isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, (int, float)) and 0 < value < 4_000_000_000:
        return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat()
    return None


def platform_calendar_date(value):
    # datetime subclasses date: reject it explicitly, including values that
    # an extractor already converted from an epoch timestamp. Only an actual
    # calendar-only upstream value is evidence of a platform publication day.
    if isinstance(value, datetime.date) and not isinstance(value, datetime.datetime):
        return value.strftime("%Y%m%d")
    return None


def small_id(value):
    return str(value)[:200] if isinstance(value, (str, int)) else ""


def emit(value):
    line = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    emit.bytes += len(line) + 1
    if emit.bytes > MAX_OUTPUT_BYTES:
        raise SourceError("metadata-too-large")
    print(line, flush=True)


emit.bytes = 0


class Collector:
    def __init__(self, maximum, deadline, known_media_keys=()):
        self.maximum = maximum
        self.deadline = deadline
        self.items = {}
        self.unsupported = 0
        self.nodes = 0
        self.scope = "unknown"
        self.engine = ""
        self.extractor = ""
        self.complete = False
        self.known_media_keys = set(known_media_keys)
        self.known_skipped = set()
        self.coverage_reasons = set()
        self.post_coverage = {}
        self.posts = {}
        self.post_media_keys = {}
        self.pagination_states = {}

    def pagination(self, metadata, key="root"):
        if not isinstance(metadata, dict):
            return
        flags = [metadata[field] for field in ("has_more", "hasMore", "has_next_page")
                 if field in metadata and metadata[field] in (True, False, 0, 1)]
        if flags:
            self.pagination_states[key] = any(bool(flag) for flag in flags)
        if any(self.pagination_states.values()):
            self.coverage_reasons.add("next-page-unconfirmed")
        else:
            self.coverage_reasons.discard("next-page-unconfirmed")
        if metadata.get("is_truncated") is True:
            self.coverage_reasons.add("extractor-truncated")

    def finish(self):
        if self.unsupported:
            self.coverage_reasons.add("unsupported-media")
        if any(value["expected"] and (len(value["indices"]) < value["expected"]
                                     or len(self.post_media_keys.get(post_id, ())) < value["expected"])
               for post_id, value in self.post_coverage.items()):
            self.coverage_reasons.add("attachment-count-mismatch")
        self.complete = self.scope == "account" and not self.coverage_reasons

    def unresolved_posts(self):
        return [{**item, "reason": "attachment-coverage-unconfirmed"}
                for item in self.covered_posts() if not item["mediaComplete"]]

    def covered_posts(self):
        result = []
        for post_id, post in self.posts.items():
            coverage = self.post_coverage.get(post_id)
            observed = len(self.post_media_keys.get(post_id, ()))
            covered = (len(coverage["indices"]) == coverage["expected"] and observed >= coverage["expected"]) if coverage else self.complete
            result.append({**post, "mediaComplete": covered,
                           "expectedAttachmentCount": max(coverage["expected"] if coverage else 0, observed),
                           "expectedCount": coverage["expected"] if coverage else None,
                           "observedCount": observed})
        return result

    def note_post(self, post_id, post_url, date=None, publication_date=None, expected_count=None):
        if isinstance(expected_count, str) and expected_count.isdigit():
            expected_count = int(expected_count)
        post_id = small_id(post_id)
        if not post_id or not isinstance(expected_count, int) or isinstance(expected_count, bool) or expected_count <= 0:
            return
        self.posts[post_id] = {"postId": post_id, "postUrl": post_url, "createdAt": date,
                               "publicationDate": publication_date, "dateBasis": "platform" if publication_date else "unknown"}
        coverage = self.post_coverage.setdefault(post_id, {"expected": 0, "indices": set(), "postUrl": post_url})
        coverage["expected"] = max(coverage["expected"], expected_count)

    def check(self):
        if time.monotonic() > self.deadline:
            raise SourceError("metadata-timeout")
        self.nodes += 1
        if self.nodes > min(self.maximum * 15 + len(self.known_media_keys) * 8 + 100, 1_000_000):
            raise BudgetReached()

    def item(self, key, post_id, url, extension, date=None, post_url=None, index=1, publication_date=None, expected_count=None):
        self.check()
        extension = str(extension or "").lower().lstrip(".")
        kind = "gif" if extension == "gif" else "image" if extension in IMAGE_EXTENSIONS else "video" if extension == "mp4" else None
        if not kind or not key or not isinstance(url, str) or url.startswith("ytdl:"):
            self.unsupported += 1
            return
        parsed = checked_url(url)
        if parsed.path.lower().endswith((".m3u8", ".mpd")):
            self.unsupported += 1
            return
        if key in self.items:
            return
        post_id = small_id(post_id) or hashlib.sha256(key.encode()).hexdigest()[:20]
        logical_key = "custom:" + hashlib.sha256(key.encode()).hexdigest()
        if logical_key not in self.known_media_keys and len(self.items) >= self.maximum:
            raise BudgetReached()
        self.posts[post_id] = {"postId": post_id, "postUrl": post_url, "createdAt": date,
                               "publicationDate": publication_date, "dateBasis": "platform" if publication_date else "unknown"}
        self.post_media_keys.setdefault(post_id, set()).add(logical_key)
        if isinstance(expected_count, str) and expected_count.isdigit():
            expected_count = int(expected_count)
        if isinstance(expected_count, int) and not isinstance(expected_count, bool) and expected_count > 0:
            coverage = self.post_coverage.setdefault(post_id, {"expected": 0, "indices": set(), "postUrl": post_url})
            coverage["expected"] = max(coverage["expected"], expected_count)
            if isinstance(index, int) and not isinstance(index, bool) and 0 < index <= expected_count:
                coverage["indices"].add(index)
        if logical_key in self.known_media_keys:
            self.known_skipped.add(key)
            return
        item = {"key": key, "postId": post_id,
                "url": url, "kind": kind, "extension": "." + extension, "createdAt": date,
                "postUrl": post_url, "index": index if isinstance(index, int) and 0 < index < 10000 else 1,
                "publicationDate": publication_date,
                "dateBasis": "platform" if publication_date else "unknown", "displayTimeZone": None,
                "expectedCount": expected_count if isinstance(expected_count, int) and not isinstance(expected_count, bool) else None}
        self.items[key] = item
        emit({"type": "media", **item})


def ytdlp_collect(options, collector):
    from yt_dlp import YoutubeDL
    from yt_dlp.globals import plugin_dirs
    plugin_dirs.value = []

    class QuietLogger:
        def debug(self, message):
            pass
        def warning(self, message):
            pass
        def error(self, message):
            pass

    settings = {"quiet": True, "no_warnings": True, "logger": QuietLogger(), "skip_download": True,
                "cookiefile": options.get("cookieFile") or None, "cachedir": False, "proxy": "",
                "socket_timeout": 20, "retries": 0, "extractor_retries": 0, "ignoreerrors": False,
                "geo_bypass": False, "usenetrc": False, "js_runtimes": {}, "remote_components": [],
                "postprocessors": [], "noprogress": True, "allow_unplayable_formats": False}
    collector.engine = "yt-dlp"
    visited = set()
    with YoutubeDL(settings) as ydl:
        def visit(url, depth=0, info=None):
            collector.check()
            if depth > 5 or url in visited:
                if depth > 5:
                    collector.unsupported += 1
                return
            visited.add(url)
            info = info or ydl.extract_info(url, download=False, process=False)
            if not isinstance(info, dict):
                raise SourceError("unsupported-url")
            extractor_key = str(info.get("extractor_key") or info.get("extractor") or "unknown")
            if depth == 0:
                collector.extractor = extractor_key
                # A generic/embedded page can contain a playlist, not necessarily an account.
                account_extractor = re.search(r"(?:user|channel|profile|uploads)(?:videos|posts|tab)?$", extractor_key, re.I)
                collector.scope = "account" if info.get("_type") == "playlist" and account_extractor and (info.get("uploader_id") or info.get("channel_id")) else "single" if info.get("_type", "video") == "video" else "unknown"
            result_type = info.get("_type", "video")
            if result_type in {"playlist", "multi_video"}:
                collector.pagination(info, url)
                entries = info.get("entries")
                if entries is None or isinstance(entries, (str, bytes, dict)):
                    collector.coverage_reasons.add("playlist-coverage-unknown")
                    return
                observed = 0
                for child in entries:
                    observed += 1
                    collector.check()
                    if not isinstance(child, dict):
                        collector.unsupported += 1
                        continue
                    child_url = child.get("webpage_url") or child.get("url")
                    if child.get("_type") in {"url", "url_transparent"}:
                        checked_url(child_url)
                        if not same_host(checked_url(child_url).hostname, checked_url(options["url"]).hostname):
                            collector.unsupported += 1
                            continue
                        visit(child_url, depth + 1)
                    else:
                        visit(child_url or (url + "#" + str(child.get("id"))), depth + 1, child)
                expected = info.get("playlist_count", info.get("n_entries"))
                if expected is not None and (not isinstance(expected, int) or isinstance(expected, bool) or expected != observed):
                    collector.coverage_reasons.add("playlist-count-mismatch")
                requested = info.get("requested_entries")
                if isinstance(requested, (list, tuple)) and len(requested) != observed:
                    collector.coverage_reasons.add("extractor-truncated")
                return
            if result_type in {"url", "url_transparent"}:
                child_url = info.get("url")
                checked_url(child_url)
                if not same_host(checked_url(child_url).hostname, checked_url(options["url"]).hostname):
                    raise SourceError("external-embed-unsupported")
                visit(child_url, depth + 1)
                return
            candidates = info.get("formats") or [info]
            candidates = [item for item in candidates if isinstance(item, dict) and item.get("url")
                          and item.get("ext") == "mp4" and item.get("protocol", "https") in {"https", "http"}
                          and item.get("vcodec") != "none" and item.get("acodec") != "none"
                          and not item.get("has_drm")]
            if not candidates:
                collector.unsupported += 1
                return
            selected = max(candidates, key=lambda item: (item.get("height") or 0, item.get("tbr") or 0))
            post_id = small_id(info.get("id"))
            if not post_id:
                collector.unsupported += 1
                return
            collector.item("yt-dlp:" + extractor_key + ":" + post_id, post_id, selected["url"], "mp4",
                           date_string(info.get("timestamp")), info.get("webpage_url") or url)
        visit(options["url"])
    collector.finish()


def main():
    raw_input = sys.stdin.buffer.readline(MAX_INPUT_BYTES + 1)
    if len(raw_input) > MAX_INPUT_BYTES:
        raise SourceError("metadata-too-large")
    options = json.loads(raw_input.decode("utf-8"))
    if options.get("command") == "versions":
        from importlib.metadata import version
        emit({"type": "versions", "yt-dlp": version("yt-dlp")})
        return
    if options.get("engine") == "gallery-dl":
        raise SourceError("public-engine-not-integrated")
    if options.get("engine") not in {"auto", "yt-dlp"}:
        raise SourceError("unsupported-engine")
    homepage = checked_url(options["homepage"])
    target = checked_url(options["url"])
    if not same_host(homepage.hostname, target.hostname):
        raise SourceError("target-domain-mismatch")
    maximum = min(max(int(options.get("maxItems", 2000)), 1), 10000)
    deadline = time.monotonic() + min(max(float(options.get("timeoutSeconds", 120)), 1), 900)
    logging.disable(logging.CRITICAL)
    install_network_guards(options["homepage"], deadline)
    collector = Collector(maximum, deadline, options.get("knownMediaKeys") or ())
    try:
        ytdlp_collect(options, collector)
    except BudgetReached:
        collector.complete = False
        collector.coverage_reasons.add("metadata-budget")
    if not collector.items and not collector.known_skipped and not collector.unresolved_posts():
        raise SourceError("unsupported-media" if collector.unsupported else "no-verifiable-media")
    emit({"type": "result", "complete": collector.complete, "scope": collector.scope,
          "engine": collector.engine, "extractor": collector.extractor,
          "unsupported": collector.unsupported, "mediaCount": len(collector.items), "knownSkipped": len(collector.known_skipped),
          "coverageVersion": 1, "coverageComplete": collector.complete, "coverageReasons": sorted(collector.coverage_reasons),
          "unresolvedPosts": collector.unresolved_posts(), "coveredPosts": collector.covered_posts(), "postCount": len(collector.posts)})


if __name__ == "__main__":
    try:
        main()
    except SourceError as error:
        emit({"type": "error", "code": error.code})
        sys.exit(2)
    except Exception:
        # Upstream exceptions may contain private signed URLs or cookie values.
        emit({"type": "error", "code": "engine-request-failed"})
        sys.exit(2)
