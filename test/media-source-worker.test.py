import importlib.util
import hashlib
import datetime
import io
import pathlib
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("source_worker", ROOT / "scripts" / "media-source-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def test_gallery_is_rejected_before_network_and_the_worker_has_no_gallery_import(self):
        import ast
        source = (ROOT / "scripts" / "media-source-worker.py").read_text(encoding="utf-8")
        imports = [node.module for node in ast.walk(ast.parse(source)) if isinstance(node, ast.ImportFrom)]
        self.assertFalse(any(name and name.startswith("gallery_dl") for name in imports))
        self.assertFalse(hasattr(worker, "gallery_collect"))
        class Input:
            buffer = io.BytesIO(b'{"engine":"gallery-dl"}\n')
        with patch.object(worker.sys, "stdin", Input()), patch.object(worker, "install_network_guards") as network, \
             patch.object(worker, "ytdlp_collect") as collect:
            with self.assertRaises(worker.SourceError) as error:
                worker.main()
            self.assertEqual(error.exception.code, "public-engine-not-integrated")
            network.assert_not_called()
            collect.assert_not_called()

    def test_only_original_calendar_dates_are_platform_date_evidence(self):
        self.assertEqual(worker.platform_calendar_date(datetime.date(2026, 1, 1)), "20260101")
        self.assertIsNone(worker.platform_calendar_date(datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)))
        self.assertIsNone(worker.platform_calendar_date(1767225600))

    def test_oversized_input_reports_explicit_limit_before_parsing_or_importing_engines(self):
        class Input:
            buffer = io.BytesIO(b"{\"long\":\"unclosed-json")
        with patch.object(worker, "MAX_INPUT_BYTES", 8), patch.object(worker.sys, "stdin", Input()):
            with self.assertRaises(worker.SourceError) as error:
                worker.main()
            self.assertEqual(error.exception.code, "metadata-too-large")

    def test_request_guards_block_post_private_dns_and_redirect_cookie_leaks(self):
        import requests
        import socket
        import subprocess
        import os
        import http.client
        import http.cookiejar
        import urllib.request
        calls = []
        def dns(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1" if host == "private.example" else "8.8.8.8", port))]
        def send(session, request, **kwargs):
            calls.append((request.url, dict(request.headers)))
            response = requests.Response()
            response.status_code = 302 if request.url.endswith("/redirect") else 200
            response.headers = {"location": "https://cdn.example/image"} if response.status_code == 302 else {}
            response.raw = io.BytesIO(b"fixture")
            response.url = request.url
            return response
        targets = [(socket, "getaddrinfo"), (socket.socket, "connect"), (socket.socket, "connect_ex"),
                   (http.client.HTTPResponse, "read"), (requests.Session, "send"),
                   (urllib.request.OpenerDirector, "open"), (http.cookiejar.CookieJar, "add_cookie_header"),
                   (subprocess, "Popen"), (os, "system")]
        originals = [(owner, name, getattr(owner, name)) for owner, name in targets]
        environment = dict(os.environ)
        try:
            socket.getaddrinfo = dns
            requests.Session.send = send
            worker.install_network_guards("https://site.example/", float("inf"))
            session = requests.Session()
            response = session.get("https://site.example/redirect", headers={"Cookie": "session=private"}, stream=True)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(calls[0][1].get("Cookie"), "session=private")
            self.assertNotIn("Cookie", calls[1][1])
            with self.assertRaises(worker.SourceError):
                session.post("https://site.example/write", data="must not be sent")
            with self.assertRaises(worker.SourceError):
                session.get("https://private.example/secret")
            self.assertEqual(len(calls), 2)
        finally:
            for owner, name, original in originals:
                setattr(owner, name, original)
            os.environ.clear()
            os.environ.update(environment)

    def test_public_network_only(self):
        for value in ("127.0.0.1", "10.1.1.1", "100.64.1.1", "169.254.169.254", "::1", "2001:db8::1", "::ffff:8.8.8.8", "2002:0808:0808::1"):
            self.assertFalse(worker.public_ip(value), value)
        self.assertTrue(worker.public_ip("8.8.8.8"))
        self.assertTrue(worker.public_ip("2606:4700::1111"))
        for url in ("file:///tmp/private", "https://127.0.0.1/", "https://user:pw@example.com/", "http://example.com/", "https://example.com:8000/"):
            with self.assertRaises(worker.SourceError):
                worker.checked_url(url)

    def test_metadata_reader_is_bounded_and_original_read_does_not_recurse(self):
        original = io.BytesIO(b"abcdefgh")
        reader = worker.LimitedReader(original, float("inf"))
        original.read = reader.read
        self.assertEqual(original.read(3), b"abc")
        self.assertEqual(original.read(), b"defgh")
        with patch.object(worker, "MAX_METADATA_BYTES", 2):
            with self.assertRaises(worker.SourceError):
                worker.LimitedReader(io.BytesIO(b"123"), float("inf")).read()

    def test_collector_preserves_ids_and_rejects_manifests(self):
        collector = worker.Collector(2, float("inf"))
        emitted = []
        with patch.object(worker, "emit", emitted.append):
            collector.item("engine:123_1", "123", "https://cdn.example/a.jpg?signature=secret", "jpg")
            collector.item("engine:123_1", "123", "https://cdn.example/a.jpg?signature=changed", "jpg")
            collector.item("engine:123_2", "123", "https://cdn.example/a.m3u8", "mp4")
        self.assertEqual(len(emitted), 1)
        self.assertEqual(collector.unsupported, 1)
        self.assertFalse(collector.complete)

    def test_repeated_known_archive_key_cannot_count_as_two_album_attachments(self):
        known = "custom:" + hashlib.sha256(b"same-archive-key").hexdigest()
        collector = worker.Collector(5, float("inf"), [known])
        collector.scope = "account"
        with patch.object(worker, "emit", lambda value: None):
            for index in (1, 2):
                collector.item("same-archive-key", "123", "https://cdn.example/a.jpg", "jpg", index=index, expected_count=2)
        collector.finish()
        self.assertFalse(collector.complete)
        self.assertIn("attachment-count-mismatch", collector.coverage_reasons)
        self.assertEqual(collector.covered_posts()[0]["observedCount"], 1)
        self.assertEqual(collector.covered_posts()[0]["expectedAttachmentCount"], 2)
        self.assertFalse(collector.covered_posts()[0]["mediaComplete"])

    def test_source_result_carries_versioned_coverage_proof(self):
        class Input:
            buffer = io.BytesIO(b'{"engine":"yt-dlp","homepage":"https://site.example/","url":"https://site.example/creator"}\n')
        def collect(options, collector):
            collector.scope = "account"
            collector.engine = "yt-dlp"
            collector.item("fixture:123", "123", "https://cdn.example/a.jpg", "jpg")
            collector.finish()
        emitted = []
        with patch.object(worker.sys, "stdin", Input()), patch.object(worker, "install_network_guards"), \
             patch.object(worker, "ytdlp_collect", collect), patch.object(worker, "emit", emitted.append):
            worker.main()
        result = emitted[-1]
        self.assertEqual(result["type"], "result")
        self.assertEqual(result["coverageVersion"], 1)
        self.assertTrue(result["coverageComplete"])
        self.assertEqual(result["mediaCount"], 1)
        self.assertEqual(result["coverageReasons"], [])
        self.assertEqual(result["unresolvedPosts"], [])
        self.assertEqual(result["coveredPosts"][0]["expectedAttachmentCount"], 1)
        self.assertEqual(result["coveredPosts"][0]["observedCount"], 1)

    def test_known_media_not_posts_are_skipped_so_multifile_post_can_continue(self):
        known_key = "custom:" + hashlib.sha256(b"engine:123_1").hexdigest()
        collector = worker.Collector(1, float("inf"), [known_key])
        collector.engine = "yt-dlp"
        emitted = []
        with patch.object(worker, "emit", emitted.append):
            collector.item("engine:123_1", "123", "https://cdn.example/a.jpg", "jpg", post_url="https://site.example/posts/123")
            collector.item("engine:123_2", "123", "https://cdn.example/b.jpg", "jpg", post_url="https://site.example/posts/123")
        self.assertEqual(len(collector.known_skipped), 1)
        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0]["key"], "engine:123_2")

    def test_ytdlp_generic_playlist_is_not_full_account_and_filters_video_only_formats(self):
        import yt_dlp

        class FakeYDL:
            def __init__(self, settings):
                self.settings = settings
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def extract_info(self, url, download, process):
                assert download is False and process is False
                return {"_type": "playlist", "extractor_key": "Generic", "uploader_id": "owner", "entries": [
                    {"id": "one", "extractor_key": "Generic", "timestamp": 1767225600, "upload_date": "20260101", "formats": [
                        {"url": "https://cdn.example/no-audio.mp4", "ext": "mp4", "protocol": "https", "vcodec": "h264", "acodec": "none", "height": 2160},
                        {"url": "https://cdn.example/complete.mp4", "ext": "mp4", "protocol": "https", "vcodec": "h264", "acodec": "aac", "height": 720},
                    ]},
                ]}
        collector = worker.Collector(5, float("inf"))
        emitted = []
        with patch.object(yt_dlp, "YoutubeDL", FakeYDL), patch.object(worker, "emit", emitted.append):
            worker.ytdlp_collect({"url": "https://site.example/creator"}, collector)
        self.assertEqual(collector.scope, "unknown")
        self.assertFalse(collector.complete)
        self.assertEqual(emitted[0]["url"], "https://cdn.example/complete.mp4")
        self.assertIsNone(emitted[0]["publicationDate"])
        self.assertEqual(emitted[0]["dateBasis"], "unknown")

    def test_ytdlp_account_playlist_verifies_count_next_page_and_missing_entries(self):
        import yt_dlp
        child = {"id": "one", "extractor_key": "Fixture", "url": "https://cdn.example/a.mp4", "ext": "mp4",
                 "protocol": "https", "vcodec": "h264", "acodec": "aac"}
        scenarios = [
            ({"entries": [child], "playlist_count": 1}, True, None),
            ({"entries": [child], "playlist_count": 2}, False, "playlist-count-mismatch"),
            ({"entries": [child], "has_more": True}, False, "next-page-unconfirmed"),
            ({"entries": None}, False, "playlist-coverage-unknown"),
            ({"entries": [child], "requested_entries": [1, 2]}, False, "extractor-truncated"),
        ]
        for payload, complete, reason in scenarios:
            with self.subTest(payload=payload):
                class FakeYDL:
                    def __init__(self, settings): pass
                    def __enter__(self): return self
                    def __exit__(self, *args): pass
                    def extract_info(self, url, download, process):
                        return {"_type": "playlist", "extractor_key": "FixtureUser", "uploader_id": "creator", **payload}
                collector = worker.Collector(5, float("inf"))
                with patch.object(yt_dlp, "YoutubeDL", FakeYDL), patch.object(worker, "emit", lambda value: None):
                    worker.ytdlp_collect({"url": "https://site.example/creator"}, collector)
                self.assertEqual(collector.complete, complete)
                if reason:
                    self.assertIn(reason, collector.coverage_reasons)


if __name__ == "__main__":
    unittest.main()
