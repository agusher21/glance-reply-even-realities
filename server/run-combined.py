#!/usr/bin/env python3
"""Launch the Glance Reply backend with BOTH tokens (live mode, PORT 3001).

Fetches the custom.telegram and custom.groq surrogates from the vault
(authd) and execs node with TELEGRAM_BOT_TOKEN + GROQ_API_KEY set to the
surrogate values. The surrogates are never printed or written to any
file; they only travel in the child process environment. The egress
proxy swaps them for the real credentials on requests to
api.telegram.org / api.groq.com.

No DEMO_MODE: live Telegram polling + live Groq STT/LLM + live /api/send.
Created 27 Nov 2026 for the Even Realities demo-video shoot (28 Nov).
"""
import os
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

tg = dynamic_credential_entry("custom.telegram")["surrogate"]
gq = dynamic_credential_entry("custom.groq")["surrogate"]
env = dict(os.environ)
env["TELEGRAM_BOT_TOKEN"] = tg
env["GROQ_API_KEY"] = gq
env["PORT"] = os.environ.get("PORT", "3001")
# Short polls: the egress proxy kills the default 30 s long-poll
# (fetch failed on every attempt); timeout=0/5 s polls succeed.
env["TELEGRAM_POLL_TIMEOUT_SEC"] = os.environ.get("TELEGRAM_POLL_TIMEOUT_SEC", "5")
env.pop("DEMO_MODE", None)
os.chdir(os.path.expanduser("~/workspace/glance-reply-even-realities/server"))
os.execvpe("node", ["node", "src/index.js"], env)
