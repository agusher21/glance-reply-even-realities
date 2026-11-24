#!/usr/bin/env python3
"""Launch the Glance Reply backend with the Telegram token surrogate.

Fetches the custom.telegram surrogate from the vault (authd) and execs
node with TELEGRAM_BOT_TOKEN set to the surrogate value. The surrogate
is never printed or written to any file; it only travels in the child
process environment. The egress proxy swaps it for the real token on
requests to api.telegram.org.
"""
import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

surr = dynamic_credential_entry("custom.telegram")["surrogate"]
env = dict(os.environ)
env["TELEGRAM_BOT_TOKEN"] = surr
env["PORT"] = os.environ.get("PORT", "3001")
os.chdir(os.path.expanduser("~/workspace/glance-reply-even-realities/server"))
os.execvpe("node", ["node", "src/index.js"], env)
