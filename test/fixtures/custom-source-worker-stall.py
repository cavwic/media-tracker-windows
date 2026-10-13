"""Local lifecycle fixture: no filesystem changes, networking or child processes."""
import json
import sys
import time

options = json.loads(sys.stdin.readline())
if options.get("mode") == "error-hang":
    print('{"type":"error","code":"unsupported-url"}', flush=True)
elif options.get("mode") == "invalid-output":
    print('private-fixture-cookie-and-signed-url-must-not-be-logged', flush=True)
while True:
    time.sleep(1)
