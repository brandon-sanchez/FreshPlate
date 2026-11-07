"""Start a long-running command in its own process group and print its PID.

Usage: spawn.py <log_file> <cwd> <command> [args...]

The PID is also the process-group ID, so cleanup.sh can stop the command and
every child it forked (uvicorn's reloader, Metro's workers) with one signal.
"""

import subprocess
import sys

log_path, cwd, *command = sys.argv[1:]
with open(log_path, "ab") as log:
    process = subprocess.Popen(
        command,
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
print(process.pid)
