#!/usr/bin/env python3
"""Launch the Glance Reply voice backend (DEV mode) with the Groq key surrogate.

Fetches the custom.groq surrogate from the vault and execs node with
GROQ_API_KEY set to the surrogate value. The surrogate is never printed
or written to any file; it only travels in the child process environment.
The egress proxy swaps it for the real key on requests to api.groq.com.

Runs on PORT=3002 with DEMO_MODE=1 so it does not touch the live backend
on 3001.
"""
import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

surr = dynamic_credential_entry("custom.groq")["surrogate"]
env = dict(os.environ)
env["GROQ_API_KEY"] = surr
env["PORT"] = os.environ.get("PORT", "3002")
env["DEMO_MODE"] = "1"
os.chdir(os.path.expanduser("~/workspace/glance-reply-even-realities/server"))
os.execvpe("node", ["node", "src/index.js"], env)